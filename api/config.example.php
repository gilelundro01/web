<?php
/**
 * Konfigurasi Claude API.
 *
 * Cara pakai:
 *   1. Salin file ini menjadi `config.php` (di folder yang sama).
 *   2. Isi `api_key` dengan token milikmu.
 *   3. (Opsional) ubah `base_url` & `auth_header` kalau pakai proxy
 *      / API gateway selain Anthropic resmi.
 *
 * File `config.php` sudah di-ignore oleh git, jadi key tidak ke-push.
 */

return [
    /* ============================================================
     * 1) ENDPOINT
     * ============================================================
     * Pilih SATU preset di bawah dengan menghapus tanda komentar,
     * atau isi manual.
     */

    // --- Preset A: Anthropic resmi (default) ---
    'base_url'    => 'https://api.anthropic.com',
    'auth_header' => 'x-api-key',   // Anthropic pakai header `x-api-key: <key>`

    // --- Preset B: Proxy / gateway ala ecomagent / claude-code style ---
    // Hapus komentar 2 baris di atas, lalu uncomment 2 baris di bawah.
    // 'base_url'    => 'https://api.ecomagent.in',
    // 'auth_header' => 'bearer',   // pakai header `Authorization: Bearer <key>`

    /* ============================================================
     * 2) KREDENSIAL
     * ============================================================
     * Untuk Anthropic resmi: key dari https://console.anthropic.com/settings/keys
     *   formatnya `sk-ant-...`.
     * Untuk proxy: pakai token yang dikasih provider proxy-mu
     *   (mis. nilai dari env ANTHROPIC_AUTH_TOKEN).
     */
    'api_key' => 'isi-token-anda-di-sini',

    /* ============================================================
     * 3) MODEL
     * ============================================================ */

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

    /* ============================================================
     * 4) OPSI LAIN
     * ============================================================ */

    // System prompt default. Boleh dikosongkan.
    'system_prompt' => 'You are a helpful, concise assistant. Reply in the same language as the user.',

    // Maks token output per response.
    'max_tokens' => 1024,

    // Timeout request ke API (detik).
    'timeout' => 60,

    // Versi API Anthropic. Jangan diubah kecuali tahu apa yang dilakukan.
    'anthropic_version' => '2023-06-01',
];
