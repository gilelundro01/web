<?php
/**
 * Konfigurasi Claude API.
 *
 * Cara pakai:
 *   1. Salin file ini menjadi `config.php` (di folder yang sama).
 *   2. Ganti nilai ANTHROPIC_API_KEY dengan API key milikmu dari
 *      https://console.anthropic.com/settings/keys
 *   3. (Opsional) ubah model default & system prompt sesuai kebutuhan.
 *
 * File `config.php` sudah di-ignore oleh git, jadi key tidak akan ke-push.
 */

return [
    // API key Anthropic — WAJIB diisi.
    'api_key' => 'sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxx',

    // Model default. Bisa di-override dari frontend lewat dropdown.
    // Lihat daftar model di https://docs.anthropic.com/en/docs/about-claude/models
    'default_model' => 'claude-sonnet-4-5',

    // Daftar model yang ditawarkan ke user di UI.
    'allowed_models' => [
        'claude-sonnet-4-5'    => 'Claude Sonnet 4.5',
        'claude-opus-4-5'      => 'Claude Opus 4.5',
        'claude-haiku-4-5'     => 'Claude Haiku 4.5',
        'claude-3-5-sonnet-latest' => 'Claude 3.5 Sonnet',
        'claude-3-5-haiku-latest'  => 'Claude 3.5 Haiku',
    ],

    // System prompt default. Boleh dikosongkan.
    'system_prompt' => 'You are a helpful, concise assistant. Reply in the same language as the user.',

    // Maks token output per response.
    'max_tokens' => 1024,

    // Timeout request ke Anthropic (detik).
    'timeout' => 60,

    // Versi API Anthropic. Jangan diubah kecuali tahu apa yang dilakukan.
    'anthropic_version' => '2023-06-01',
];
