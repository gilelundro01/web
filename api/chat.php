<?php
/**
 * Proxy endpoint untuk Anthropic Messages API.
 *
 * Frontend POST JSON:
 *   {
 *     "model":    "claude-sonnet-4-5",          // optional
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

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

// Hanya izinkan POST.
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'Method not allowed']);
    exit;
}

// Load config.
$configPath = __DIR__ . '/config.php';
if (!is_file($configPath)) {
    http_response_code(500);
    echo json_encode([
        'ok' => false,
        'error' => 'config.php belum dibuat. Salin api/config.example.php menjadi api/config.php lalu isi API key.',
    ]);
    exit;
}

$config = require $configPath;
$apiKey = is_array($config) ? (string) ($config['api_key'] ?? '') : '';
if (
    !is_array($config)
    || $apiKey === ''
    || $apiKey === 'isi-token-anda-di-sini'
    || str_starts_with($apiKey, 'sk-ant-xxxx')
) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'API key belum diisi di api/config.php.']);
    exit;
}

// Endpoint & auth scheme.
$baseUrl    = rtrim((string) ($config['base_url'] ?? 'https://api.anthropic.com'), '/');
$authScheme = strtolower((string) ($config['auth_header'] ?? 'x-api-key'));

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

// Pilih model: default config, kecuali user pilih dari allowed_models.
$model = $config['default_model'];
if (isset($body['model']) && is_string($body['model']) && isset($config['allowed_models'][$body['model']])) {
    $model = $body['model'];
}

$payload = [
    'model'      => $model,
    'max_tokens' => (int) ($config['max_tokens'] ?? 1024),
    'messages'   => $cleanMessages,
];
if (!empty($config['system_prompt'])) {
    $payload['system'] = $config['system_prompt'];
}

// Build auth header sesuai konfigurasi.
$headers = [
    'Content-Type: application/json',
    'anthropic-version: ' . ($config['anthropic_version'] ?? '2023-06-01'),
];
if ($authScheme === 'bearer') {
    $headers[] = 'Authorization: Bearer ' . $apiKey;
} else {
    $headers[] = 'x-api-key: ' . $apiKey;
}

// Panggil endpoint Messages.
$ch = curl_init($baseUrl . '/v1/messages');
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
    $errMsg = $data['error']['message'] ?? ('HTTP ' . $httpCode);
    http_response_code($httpCode);
    echo json_encode(['ok' => false, 'error' => $errMsg]);
    exit;
}

// Ekstrak teks dari content blocks.
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
