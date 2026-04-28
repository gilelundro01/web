<?php
/**
 * Proxy endpoint untuk Claude API.
 *
 * Mendukung 2 format:
 *   - anthropic : POST /v1/messages,        x-api-key / Bearer
 *   - openai    : POST /v1/chat/completions, Bearer
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

// Build payload + headers sesuai format.
if ($creds['api_format'] === 'openai') {
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
        'stream'     => false,
    ];

    $headers = [
        'Content-Type: application/json',
        'Authorization: Bearer ' . $creds['api_key'],
    ];
} else { // anthropic
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
}

// Panggil endpoint.
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

// Ekstrak teks reply.
$reply = '';
if ($creds['api_format'] === 'openai') {
    $choice = $data['choices'][0] ?? null;
    if (is_array($choice)) {
        $msg = $choice['message'] ?? null;
        if (is_array($msg)) {
            // content bisa string atau array of parts (gpt-style multi-part)
            if (is_string($msg['content'] ?? null)) {
                $reply = $msg['content'];
            } elseif (is_array($msg['content'] ?? null)) {
                foreach ($msg['content'] as $part) {
                    if (is_array($part) && isset($part['text'])) {
                        $reply .= (string) $part['text'];
                    } elseif (is_string($part)) {
                        $reply .= $part;
                    }
                }
            }
        }
    }
} else { // anthropic
    foreach (($data['content'] ?? []) as $block) {
        if (($block['type'] ?? '') === 'text') {
            $reply .= $block['text'] ?? '';
        }
    }
}

echo json_encode([
    'ok'    => true,
    'reply' => $reply,
    'model' => $data['model'] ?? $model,
    'usage' => $data['usage'] ?? null,
], JSON_UNESCAPED_UNICODE);
