<?php
/**
 * Helper bersama: load kredensial dari keys.env + load config.php.
 */

declare(strict_types=1);

/**
 * Parse file `.env` sederhana menjadi associative array.
 *
 * - Baris kosong & yang diawali `#` diabaikan.
 * - Format `KEY=VALUE`. Spasi di sekitar `=` di-trim.
 * - Tanda kutip pembungkus tunggal/ganda di nilai dilepas.
 * - Kunci di-uppercase agar konsisten.
 *
 * @return array<string,string>
 */
function load_env_file(string $path): array
{
    $out = [];
    if (!is_file($path)) return $out;

    $lines = @file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if ($lines === false) return $out;

    foreach ($lines as $line) {
        $trim = trim($line);
        if ($trim === '' || $trim[0] === '#') continue;

        $eq = strpos($trim, '=');
        if ($eq === false) continue;

        $key = strtoupper(trim(substr($trim, 0, $eq)));
        $val = trim(substr($trim, $eq + 1));

        // Lepas tanda kutip pembungkus.
        if (strlen($val) >= 2) {
            $first = $val[0];
            $last  = $val[strlen($val) - 1];
            if (($first === '"' && $last === '"') || ($first === "'" && $last === "'")) {
                $val = substr($val, 1, -1);
            }
        }

        if ($key !== '') $out[$key] = $val;
    }
    return $out;
}

/**
 * Load kredensial. Mengembalikan ['api_key'=>..., 'base_url'=>..., 'auth_header'=>...]
 * atau melempar RuntimeException kalau belum di-setup.
 *
 * Sumber (urutan prioritas dari atas):
 *   1. api/keys.env (KEY=VALUE plain text — direkomendasikan)
 *   2. environment variables ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / API_KEY
 *      (kalau hosting kamu mendukung env var)
 *
 * @return array{api_key:string, base_url:string, auth_header:string}
 */
function load_credentials(string $apiDir): array
{
    $envPath    = $apiDir . '/keys.env';
    $exampleEnv = $apiDir . '/keys.env.example';

    $env = load_env_file($envPath);

    // Fallback ke environment process kalau ada (lebih aman di hosting yang support).
    $apiKey = $env['API_KEY']
        ?? $env['ANTHROPIC_AUTH_TOKEN']
        ?? getenv('API_KEY')
        ?: (getenv('ANTHROPIC_AUTH_TOKEN') ?: '');
    $apiKey = (string) $apiKey;

    $baseUrl = $env['BASE_URL']
        ?? $env['ANTHROPIC_BASE_URL']
        ?? getenv('BASE_URL')
        ?: (getenv('ANTHROPIC_BASE_URL') ?: 'https://api.anthropic.com');
    $baseUrl = (string) $baseUrl;

    $authHeader = strtolower((string) (
        $env['AUTH_HEADER']
        ?? getenv('AUTH_HEADER')
        ?: 'x-api-key'
    ));

    if (!is_file($envPath) && !is_file($exampleEnv)) {
        throw new RuntimeException(
            'File api/keys.env.example tidak ditemukan. Repo terinstal tidak lengkap.'
        );
    }
    if (!is_file($envPath)) {
        throw new RuntimeException(
            'api/keys.env belum dibuat. Salin api/keys.env.example menjadi api/keys.env lalu isi API_KEY.'
        );
    }
    if ($apiKey === '' || $apiKey === 'isi-token-anda-di-sini' || str_starts_with($apiKey, 'sk-ant-xxxx')) {
        throw new RuntimeException(
            'API_KEY belum diisi. Edit api/keys.env dan isi nilai API_KEY.'
        );
    }

    return [
        'api_key'     => $apiKey,
        'base_url'    => rtrim($baseUrl, '/'),
        'auth_header' => $authHeader === 'bearer' ? 'bearer' : 'x-api-key',
    ];
}

/**
 * Load config non-secret. Selalu mengembalikan array dengan default
 * (kalau config.php belum dibuat, pakai api/config.example.php).
 *
 * @return array<string,mixed>
 */
function load_config(string $apiDir): array
{
    $primary  = $apiDir . '/config.php';
    $fallback = $apiDir . '/config.example.php';
    $path = is_file($primary) ? $primary : (is_file($fallback) ? $fallback : null);
    if ($path === null) return [];
    $cfg = require $path;
    return is_array($cfg) ? $cfg : [];
}
