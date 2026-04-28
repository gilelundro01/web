# Claude Chat — Web Frontend untuk Anthropic API

Web chat sederhana yang berbicara dengan Claude lewat backend PHP. Dirancang
khusus agar bisa di-host di **InfinityFree** (atau hosting PHP gratis lain),
karena hanya butuh PHP 7.4+ dan ekstensi `curl` — **tidak butuh Node.js,
tidak butuh database**.

## Fitur

- Chat **multi-turn** (riwayat disimpan di `localStorage` browser).
- Pilih model dari dropdown (Sonnet / Opus / Haiku, dst.).
- Tombol **New chat** untuk reset percakapan.
- UI **dark mode** responsive (mobile-friendly).
- Tombol Enter = kirim, Shift+Enter = baris baru.
- Render code block (\`\`\`...\`\`\`) dan inline `code`.
- API key Anthropic disimpan **server-side** (di `api/config.php`), tidak
  pernah dikirim ke browser.

## Struktur

```
.
├── index.html          # UI chat
├── assets/
│   ├── style.css
│   └── app.js
├── api/
│   ├── config.example.php  # template config (commit ke git)
│   ├── config.php          # ⬅️ config asli (di-gitignore, kamu yang buat)
│   ├── chat.php            # proxy ke /v1/messages
│   └── models.php          # daftar model untuk dropdown
└── README.md
```

## Setup lokal (opsional, untuk testing)

Butuh PHP 8+ dengan ekstensi `curl`.

```bash
# 1. Salin config & isi API key
cp api/config.example.php api/config.php
# edit api/config.php → isi 'api_key' dengan key dari
# https://console.anthropic.com/settings/keys

# 2. Jalankan dev server
php -S 127.0.0.1:8000

# 3. Buka http://127.0.0.1:8000
```

## Deploy ke InfinityFree

1. **Buat akun & hosting** di <https://infinityfree.net>. Catat domain
   gratisnya, mis. `namaproject.epizy.com`.

2. **Dapatkan API key** Anthropic dari
   <https://console.anthropic.com/settings/keys> (formatnya
   `sk-ant-...`). Pastikan akun Anthropic kamu sudah punya saldo —
   tanpa saldo, request akan gagal dengan error 400/credit.

3. **Siapkan `api/config.php`**: salin `api/config.example.php` jadi
   `api/config.php` lalu ubah baris:
   ```php
   'api_key' => 'sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxx',
   ```
   menjadi API key kamu.

4. **Upload semua file** ke folder `htdocs/` di InfinityFree
   (lewat File Manager di control panel atau FTP). Strukturnya harus
   tetap sama:
   ```
   htdocs/
     index.html
     assets/...
     api/...
   ```

5. **Buka domain kamu** di browser. Coba kirim pesan. Kalau muncul
   error "config.php belum dibuat" atau "API key belum diisi", balik ke
   langkah 3.

### Catatan khusus InfinityFree

- **Cloudflare / "Browser check"**: domain InfinityFree default
  mengaktifkan proteksi yang kadang membuat fetch gagal saat halaman
  pertama kali dibuka. Refresh sekali lagi setelah lolos verifikasi.
- **CORS**: tidak perlu setting apa-apa karena frontend & backend ada
  di domain yang sama.
- **Outbound HTTPS**: InfinityFree mengizinkan request keluar
  via cURL ke `api.anthropic.com`. Kalau kamu sengaja host frontend di
  domain lain, ubah `fetch('api/chat.php', …)` di `assets/app.js`
  menjadi URL absolut backend kamu, dan tambahkan header CORS di
  `api/chat.php`.
- **Timeout**: free tier kadang membatasi script PHP ~30 detik. Kalau
  mau response panjang, turunkan `max_tokens` di `config.php`.

## Mengganti API key

Tinggal edit `api/config.php` di hosting (lewat File Manager) — tidak
perlu re-deploy file lain.

## Keamanan

- `api/config.php` di-`.gitignore`, jadi key kamu tidak akan ke-push
  ke GitHub.
- Backend hanya menerima POST JSON; field `model` divalidasi terhadap
  `allowed_models`, sehingga user tidak bisa memaksa model arbitrer.
- Tidak ada API key yang pernah dikirim ke browser.

## Lisensi

Tidak ada lisensi eksplisit; gunakan sesuka hati.
