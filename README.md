# Claude Chat — Web UI ala Devin

Web chat dengan tampilan ala Devin yang berbicara dengan Claude lewat backend
PHP. Dirancang khusus agar bisa di-host di **InfinityFree** (atau hosting PHP
gratis lain) — hanya butuh PHP 7.4+ dengan ekstensi `curl`. **Tidak butuh**
Node.js, tidak butuh database.

## Fitur

- **UI ala Devin**: pesan minimalis dengan label nama (You / Claude),
  avatar bulat, accent oranye.
- **Status pill multi-step**: saat menunggu jawaban, ditampilkan tahapan
  `Thinking → Deciding next action → Working → Generating response`
  dengan dot animasi (mirip indikator kerja Devin). *Catatan: tahapan
  ini disimulasikan di frontend karena Claude API non-streaming hanya
  mengirim 1 response final.*
- **Multi-turn** dengan history tersimpan di `localStorage` browser.
- **Suggested prompts** di empty state — klik = langsung kirim.
- **Markdown rendering**: heading, bold, italic, list (ordered & unordered),
  blockquote, link, inline code, dan code block ` ```lang ... ``` `.
- **Tombol copy** & **regenerate** di tiap pesan Claude (muncul saat hover).
- **Pilihan model** lewat dropdown (Sonnet, Opus, Haiku, dst).
- **Dark mode** responsive (HP friendly).
- **Endpoint flexible**: bisa pakai Anthropic resmi (`x-api-key`) atau
  proxy/gateway (`Authorization: Bearer`).
- **Kredensial dipisah** di file teks `api/keys.env` — gampang diedit
  pakai Notepad / File Manager tanpa risiko salah tulis PHP.
- **API key disimpan server-side**, tidak pernah dikirim ke browser, dan
  tidak akan ke-push ke GitHub.

## Struktur file

```
.
├── index.html              # UI chat
├── assets/
│   ├── style.css
│   └── app.js
├── api/
│   ├── keys.env.example    # template kredensial (commit ke git)
│   ├── keys.env            # ⬅️ kredensial asli (gitignored, kamu yang buat)
│   ├── config.example.php  # default non-secret (model list, prompt, dll)
│   ├── config.php          # opsional override (gitignored)
│   ├── lib.php             # helper: parse keys.env + load config.php
│   ├── chat.php            # proxy ke /v1/messages
│   └── models.php          # daftar model untuk dropdown
└── README.md
```

## Setup lokal (opsional, untuk testing)

Butuh PHP 8+ dengan ekstensi `curl`.

```bash
# 1. Salin kredensial template & isi token
cp api/keys.env.example api/keys.env
# edit api/keys.env → isi API_KEY (dan ubah BASE_URL/AUTH_HEADER kalau pakai proxy)

# 2. Jalankan dev server
php -S 127.0.0.1:8000

# 3. Buka http://127.0.0.1:8000
```

## Konfigurasi kredensial (`api/keys.env`)

File ini **plain text** dengan format `KEY=value`. Tidak ada PHP syntax,
tidak ada quote/koma yang bisa salah. Cukup edit dengan editor apa pun.

### Untuk EcomAgent (atau proxy OpenAI-compatible)

Mayoritas proxy Claude (ecomagent.in, claude-code custom endpoint, dll.)
sebenarnya bukan Anthropic-native — mereka pakai protokol **OpenAI Chat
Completions**. Setting:

```env
BASE_URL=https://api.ecomagent.in
API_FORMAT=openai
AUTH_HEADER=bearer
API_KEY=sk-xxxxxxxxxxxxxxxxxxxx
```

### Untuk Anthropic resmi

```env
BASE_URL=https://api.anthropic.com
API_FORMAT=anthropic
AUTH_HEADER=x-api-key
API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxx
```

### Apa bedanya?

| | `API_FORMAT=anthropic` | `API_FORMAT=openai` |
|---|---|---|
| Endpoint path | `/v1/messages` | `/v1/chat/completions` |
| Auth | `x-api-key: <key>` | `Authorization: Bearer <key>` |
| System prompt | field `system` | message dengan `role: system` |
| Response field | `content[0].text` | `choices[0].message.content` |
| Model contoh | `claude-sonnet-4-5` | `claude-opus-4.6` |

`API_FORMAT` boleh dikosongkan — kalau host BASE_URL `api.anthropic.com`
otomatis jadi `anthropic`, selain itu jadi `openai`. Tapi tetap lebih aman
diset eksplisit.

`BASE_URL` boleh dengan atau tanpa `/v1` di akhir — keduanya OK karena
script normalisasi otomatis.

### Mapping dari env style claude-code / ecomagent

Provider seperti ecomagent biasanya kasih config:

```json
{
  "ANTHROPIC_BASE_URL":   "https://api.ecomagent.in/",
  "ANTHROPIC_AUTH_TOKEN": "sk-..."
}
```

Petakan ke `keys.env`:

| Env provider                     | `keys.env`             |
| -------------------------------- | ---------------------- |
| `ANTHROPIC_BASE_URL=https://…`   | `BASE_URL=https://…`   |
| `ANTHROPIC_AUTH_TOKEN=sk-…`      | `API_KEY=sk-…`         |
| (proxy = OpenAI-compat)          | `API_FORMAT=openai`    |
| (selalu Bearer untuk proxy)      | `AUTH_HEADER=bearer`   |

## Konfigurasi non-secret (`api/config.php`, opsional)

Hanya kalau kamu mau ubah daftar model, system prompt, max_tokens, atau
timeout. Salin `api/config.example.php` jadi `api/config.php` dan edit.
Kalau tidak dibuat, default dari `config.example.php` dipakai.

## Deploy ke InfinityFree

1. **Buat akun & hosting** di <https://infinityfree.net>. Catat domain
   gratisnya, mis. `namaproject.epizy.com`.

2. **Dapatkan API key**:
   - Anthropic resmi: <https://console.anthropic.com/settings/keys>
     (formatnya `sk-ant-…`). Pastikan akun sudah punya saldo, kalau tidak
     request akan error "credit balance is too low".
   - Atau pakai provider proxy yang kamu punya.

3. **Upload file** ke folder `htdocs/` di InfinityFree (lewat File Manager
   atau FTP). Strukturnya:
   ```
   htdocs/
     index.html
     assets/...
     api/...
   ```

4. **Buat `api/keys.env`** di File Manager (pencet "New file"), isi
   sesuai contoh di atas, simpan.

5. **Buka domain kamu** di browser. Coba kirim pesan. Kalau muncul error
   "API_KEY belum diisi" — balik ke langkah 4.

### Catatan khusus InfinityFree

- **Cloudflare browser check**: kadang muncul saat halaman pertama dibuka.
  Refresh sekali setelah lolos verifikasi.
- **CORS**: tidak perlu setting karena frontend & backend di domain
  yang sama.
- **Outbound HTTPS**: InfinityFree mengizinkan request keluar via cURL ke
  `api.anthropic.com` dan ke endpoint proxy umumnya. Kalau hosting kamu
  memblokir outbound, ganti ke provider lain.
- **Timeout PHP**: free tier biasanya membatasi script ~30 detik. Kalau
  mau response panjang, turunkan `max_tokens` di `config.php`.

### Troubleshooting InfinityFree

- **`HTTP 403 (response bukan JSON)` saat chat**:
  Layer security InfinityFree (anti-DDoS / bot check / mod_security)
  nge-block POST request sebelum sampai ke PHP. Cek di DevTools
  (F12 → Network → klik request `chat.php` yang merah → tab
  Response): kalau body-nya HTML "Forbidden" / browser check, itu
  konfirmasinya.

  Coba urutan ini:
  1. Login ke client area iFastNet → cari **"Anti-DDoS"** atau
     **"Bot Fight Mode"** → nonaktifkan sementara → coba lagi.
  2. Login ke **VistaPanel** (cPanel-nya InfinityFree) → cari
     **"Suhosin"** atau **"Security"** → naikan limit / matikan strict.
  3. Pastikan `.htaccess` di root & `api/` ke-upload (file ini punya
     directive yang minta hosting jangan kompres response API).
  4. Kalau langkah 1-3 gak berhasil, coba hosting lain yang lebih
     ramah PHP: [000webhost.com](https://000webhost.com),
     [AwardSpace](https://awardspace.com), atau
     [ProFreeHost](https://profreehost.com). Upload file yang sama,
     gak perlu ubah kode.

- **`Upstream mengembalikan response kosong`**:
  Provider seperti ecomagent kadang reset / maintenance ("5 min
  break to restock"). Tunggu 5 menit & coba lagi.

- **API_KEY belum diisi**:
  Buka File Manager → `htdocs/api/keys.env` → pastikan `API_KEY=` diisi
  token asli, bukan placeholder `isi-token-anda-di-sini`.

- **Untuk model `claude-opus-4.6`**:
  Hanya tersedia di provider OpenAI-compat seperti ecomagent. Anthropic
  resmi pakai nama berbeda (`claude-opus-4-5` dst.).

## Mengganti API key / endpoint

Tinggal edit `api/keys.env` di hosting (lewat File Manager) — tidak perlu
re-deploy file lain. File ini di-`.gitignore` jadi key kamu tidak akan
ke-push ke GitHub.

## Keamanan

- Backend hanya menerima POST JSON.
- Field `model` divalidasi terhadap `allowed_models` — user tidak bisa
  memaksa model arbitrer.
- API key tidak pernah dikirim ke browser.
- `api/keys.env` & `api/config.php` di-`.gitignore`.

## Lisensi

Tidak ada lisensi eksplisit; gunakan sesuka hati.
