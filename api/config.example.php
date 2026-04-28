<?php
/**
 * Konfigurasi NON-SECRET untuk Claude Chat.
 *
 * Kredensial (API key, base_url, auth_header) TIDAK di sini —
 * lihat `api/keys.env`.
 *
 * Cara pakai:
 *   1. Salin file ini menjadi `config.php` (di folder yang sama).
 *   2. (Opsional) ubah model default, system prompt, dll.
 *   3. Untuk API key, edit `api/keys.env` (file teks biasa).
 */

return [
    // Model default. Bisa di-override dari frontend lewat dropdown.
    // Lihat daftar model: https://docs.anthropic.com/en/docs/about-claude/models
    'default_model' => 'claude-sonnet-4-5',

    // Daftar model yang ditawarkan ke user di UI.
    // Kalau provider proxy-mu hanya support sebagian, hapus yang tidak ada.
    'allowed_models' => [
        'claude-sonnet-4-5'        => 'Claude Sonnet 4.5',
        'claude-opus-4-5'          => 'Claude Opus 4.5',
        'claude-haiku-4-5'         => 'Claude Haiku 4.5',
        'claude-3-5-sonnet-latest' => 'Claude 3.5 Sonnet',
        'claude-3-5-haiku-latest'  => 'Claude 3.5 Haiku',
    ],

    // System prompt default. Boleh dikosongkan.
    'system_prompt' => 'You are a helpful, concise assistant. Reply in the same language as the user.',

    // Maks token output per response.
    'max_tokens' => 1024,

    // Timeout request ke API (detik).
    'timeout' => 60,

    // Versi API Anthropic. Jangan diubah kecuali tahu apa yang dilakukan.
    'anthropic_version' => '2023-06-01',
];
