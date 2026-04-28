<?php
/**
 * Konfigurasi NON-SECRET untuk Claude Chat.
 *
 * Kredensial (API key, base_url, auth_header, api_format) TIDAK di sini —
 * lihat `api/keys.env`.
 *
 * Cara pakai:
 *   1. Salin file ini menjadi `config.php` (di folder yang sama).
 *   2. (Opsional) ubah model default, system prompt, dll.
 */

return [
    // Model default. Bisa di-override dari frontend lewat dropdown.
    // Pastikan model yang dipilih benar-benar didukung oleh provider kamu.
    'default_model' => 'claude-opus-4.6',

    // Daftar model yang ditawarkan ke user di UI.
    //
    // Anthropic resmi (api.anthropic.com):
    //   'claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5',
    //   'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'
    //
    // EcomAgent / proxy OpenAI-compatible:
    //   'claude-opus-4.6'  (lihat https://ecomagent.in/docs untuk daftar lengkap)
    //
    // Hapus model yang tidak didukung provider kamu.
    'allowed_models' => [
        // EcomAgent style
        'claude-opus-4.6'           => 'Claude Opus 4.6',

        // Anthropic native style
        'claude-sonnet-4-5'         => 'Claude Sonnet 4.5',
        'claude-opus-4-5'           => 'Claude Opus 4.5',
        'claude-haiku-4-5'          => 'Claude Haiku 4.5',
        'claude-3-5-sonnet-latest'  => 'Claude 3.5 Sonnet',
        'claude-3-5-haiku-latest'   => 'Claude 3.5 Haiku',
    ],

    // System prompt default. Boleh dikosongkan.
    'system_prompt' => 'You are a helpful, concise assistant. Reply in the same language as the user.',

    // Maks token output per response.
    'max_tokens' => 1024,

    // Timeout request ke API (detik). InfinityFree free tier kadang batasi ~30s.
    'timeout' => 60,

    // Versi API Anthropic (cuma dipakai kalau API_FORMAT=anthropic).
    'anthropic_version' => '2023-06-01',
];
