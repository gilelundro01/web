<?php
/**
 * Proxy endpoint untuk Claude API.
 *
 * Mendukung 2 format:
 *   - anthropic : POST /v1/messages,        x-api-key / Bearer
 *   - openai    : POST /v1/chat/completions, Bearer  (DENGAN streaming)
 *
 * Catatan: untuk openai mode, kita selalu pakai stream=true ke upstream
 * lalu assemble chunks-nya server-side. Ini diperlukan karena beberapa
 * proxy (mis. ecomagent.in) bug-nya: non-streaming response selalu
 * `content: null`. Frontend tetap dapat 1 JSON response final.
 *
 * Frontend POST JSON:
 *   {
 *     "model":    "claude-opus-4.6",            // optional
 *     "messages": [{"role":"user","content":"hi"}, ...]
 *   }
 *
 * Response JSON sukses:
 *   { "ok": true, "reply": "...", "model": "...", "usage": {...} }
 *
 * Response JSON error:
 *   { "ok": false, "error": "pesan error" }
 */

declare(strict_types=1);

require_once __DIR__ . '/lib.php';

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'Method not allowed']);
    exit;
}

try {
    $creds = load_credentials(__DIR__);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
    exit;
}
$config = load_config(__DIR__);

// Parse body.
$rawBody = file_get_contents('php://input') ?: '';
$body = json_decode($rawBody, true);
if (!is_array($body)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Body harus JSON.']);
    exit;
}

$messages = $body['messages'] ?? null;
if (!is_array($messages) || count($messages) === 0) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Field "messages" wajib dan tidak boleh kosong.']);
    exit;
}

// Bersihkan & validasi messages.
$cleanMessages = [];
foreach ($messages as $m) {
    if (!is_array($m)) continue;
    $role = $m['role'] ?? '';
    $content = $m['content'] ?? '';
    if (!in_array($role, ['user', 'assistant'], true)) continue;
    if (!is_string($content) || trim($content) === '') continue;
    $cleanMessages[] = ['role' => $role, 'content' => $content];
}
if (count($cleanMessages) === 0) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Tidak ada pesan valid.']);
    exit;
}

// Pilih model.
$allowedModels = is_array($config['allowed_models'] ?? null) ? $config['allowed_models'] : [];
$defaultModel  = (string) ($config['default_model'] ?? array_key_first($allowedModels) ?? 'claude-opus-4.6');
$model = $defaultModel;
if (isset($body['model']) && is_string($body['model']) && isset($allowedModels[$body['model']])) {
    $model = $body['model'];
}

$systemPrompt = (string) ($config['system_prompt'] ?? '');
$maxTokens    = (int) ($config['max_tokens'] ?? 1024);

if ($creds['api_format'] === 'openai') {
    /* ============================================================
     * OpenAI-compat (ecomagent dll.) — pakai streaming, assemble.
     * ============================================================ */
    $url = $creds['base_url'] . '/v1/chat/completions';

    $oaMessages = [];
    if ($systemPrompt !== '') {
        $oaMessages[] = ['role' => 'system', 'content' => $systemPrompt];
    }
    foreach ($cleanMessages as $m) $oaMessages[] = $m;

    $payload = [
        'model'      => $model,
        'messages'   => $oaMessages,
        'max_tokens' => $maxTokens,
        'stream'     => true,
    ];

    $headers = [
        'Content-Type: application/json',
        'Authorization: Bearer ' . $creds['api_key'],
        'Accept: text/event-stream',
    ];

    // State akumulasi chunks (mutated dari WRITEFUNCTION callback).
    $state = [
        'content'  => '',
        'buffer'   => '',
        'usage'    => null,
        'modelOut' => null,
    ];

    $writeFn = function ($_ch, $chunk) use (&$state) {
        $state['buffer'] .= $chunk;
        // Parse line-by-line; SSE event boundary biasanya \n\n, tapi
        // kita parse data: line satu-per-satu juga aman.
        while (($nl = strpos($state['buffer'], "\n")) !== false) {
            $line = substr($state['buffer'], 0, $nl);
            $state['buffer'] = substr($state['buffer'], $nl + 1);
            $line = rtrim($line, "\r");

            if ($line === '' || strncmp($line, ':', 1) === 0) continue;
            if (strncmp($line, 'data:', 5) !== 0) continue;

            $payload = trim(substr($line, 5));
            if ($payload === '' || $payload === '[DONE]') continue;

            $evt = json_decode($payload, true);
            if (!is_array($evt)) continue;

            if (isset($evt['model']) && is_string($evt['model'])) {
                $state['modelOut'] = $evt['model'];
            }
            if (isset($evt['usage']) && is_array($evt['usage'])) {
                $state['usage'] = $evt['usage'];
            }
            $delta = $evt['choices'][0]['delta'] ?? null;
            if (is_array($delta)) {
                if (isset($delta['content']) && is_string($delta['content'])) {
                    $state['content'] .= $delta['content'];
                }
            }
        }
        return strlen($chunk);
    };

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_TIMEOUT        => (int) ($config['timeout'] ?? 60),
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_UNICODE),
        CURLOPT_WRITEFUNCTION  => $writeFn,
    ]);

    $ok       = curl_exec($ch);
    $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr  = curl_error($ch);
    curl_close($ch);

    if ($ok === false) {
        http_response_code(502);
        echo json_encode(['ok' => false, 'error' => 'Gagal menghubungi API: ' . $curlErr]);
        exit;
    }

    if ($httpCode < 200 || $httpCode >= 300) {
        // Coba parse buffer kalau upstream balas JSON error.
        $maybe = json_decode(trim($state['buffer']), true);
        $msg = is_array($maybe) ? ($maybe['error']['message'] ?? $maybe['error'] ?? $maybe['message'] ?? null) : null;
        http_response_code($httpCode);
        echo json_encode(['ok' => false, 'error' => is_string($msg) && $msg !== '' ? $msg : ('HTTP ' . $httpCode)]);
        exit;
    }

    if ($state['content'] === '') {
        // Kalau benar2 kosong, kirim error supaya UI tahu (jangan tampilkan blank).
        http_response_code(502);
        echo json_encode([
            'ok'    => false,
            'error' => 'Upstream mengembalikan response kosong.',
        ]);
        exit;
    }

    echo json_encode([
        'ok'    => true,
        'reply' => $state['content'],
        'model' => $state['modelOut'] ?? $model,
        'usage' => $state['usage'],
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

/* ============================================================
 * Anthropic native (api.anthropic.com).
 * ============================================================ */

$url = $creds['base_url'] . '/v1/messages';

$payload = [
    'model'      => $model,
    'max_tokens' => $maxTokens,
    'messages'   => $cleanMessages,
];
if ($systemPrompt !== '') {
    $payload['system'] = $systemPrompt;
}

$headers = [
    'Content-Type: application/json',
    'anthropic-version: ' . ($config['anthropic_version'] ?? '2023-06-01'),
];
if ($creds['auth_header'] === 'bearer') {
    $headers[] = 'Authorization: Bearer ' . $creds['api_key'];
} else {
    $headers[] = 'x-api-key: ' . $creds['api_key'];
}

$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST           => true,
    CURLOPT_TIMEOUT        => (int) ($config['timeout'] ?? 60),
    CURLOPT_HTTPHEADER     => $headers,
    CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_UNICODE),
]);

$response = curl_exec($ch);
$httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr  = curl_error($ch);
curl_close($ch);

if ($response === false) {
    http_response_code(502);
    echo json_encode(['ok' => false, 'error' => 'Gagal menghubungi API: ' . $curlErr]);
    exit;
}

$data = json_decode((string) $response, true);
if (!is_array($data)) {
    http_response_code(502);
    echo json_encode(['ok' => false, 'error' => 'Response API bukan JSON valid.']);
    exit;
}

if ($httpCode < 200 || $httpCode >= 300) {
    $errMsg = $data['error']['message']
        ?? (is_string($data['error'] ?? null) ? $data['error'] : null)
        ?? $data['message']
        ?? ('HTTP ' . $httpCode);
    http_response_code($httpCode);
    echo json_encode(['ok' => false, 'error' => (string) $errMsg]);
    exit;
}

$reply = '';
foreach (($data['content'] ?? []) as $block) {
    if (($block['type'] ?? '') === 'text') {
        $reply .= $block['text'] ?? '';
    }
}

echo json_encode([
    'ok'    => true,
    'reply' => $reply,
    'model' => $data['model'] ?? $model,
    'usage' => $data['usage'] ?? null,
], JSON_UNESCAPED_UNICODE);
