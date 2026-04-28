// Helper bersama untuk Vercel serverless functions.
// Kredensial diambil dari Vercel Environment Variables (prioritas) atau
// dari file `api/keys.env` (fallback, sama format dengan PHP).
//
// Env vars yang dipakai:
//   API_KEY      (atau ANTHROPIC_AUTH_TOKEN)
//   BASE_URL     (atau ANTHROPIC_BASE_URL)  default: https://api.anthropic.com
//   API_FORMAT   "anthropic" | "openai"     auto-deteksi kalau kosong
//   AUTH_HEADER  "bearer" | "x-api-key"     default tergantung API_FORMAT
//
// CARA SET DI VERCEL:
//   Vercel dashboard → Project → Settings → Environment Variables
//   Tambahkan API_KEY, BASE_URL, API_FORMAT, AUTH_HEADER.
//   Redeploy (atau push commit baru) supaya env var ke-load.

'use strict';

const fs = require('fs');
const path = require('path');

/** @type {Record<string,string>} */
function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toUpperCase();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2) {
      const f = val[0], l = val[val.length - 1];
      if ((f === '"' && l === '"') || (f === "'" && l === "'")) {
        val = val.slice(1, -1);
      }
    }
    if (key) out[key] = val;
  }
  return out;
}

function normalizeBaseUrl(url) {
  let u = (url || '').replace(/\/+$/, '');
  const m = /^(.*)\/v1$/.exec(u);
  if (m) return m[1].replace(/\/+$/, '');
  return u;
}

function loadCredentials() {
  const apiDir = __dirname;
  const envFile = parseEnvFile(path.join(apiDir, 'keys.env'));
  // Process env > keys.env (Vercel-friendly default).
  const pick = (...keys) => {
    for (const k of keys) {
      if (process.env[k] && String(process.env[k]).trim() !== '') return process.env[k];
    }
    for (const k of keys) {
      if (envFile[k] && String(envFile[k]).trim() !== '') return envFile[k];
    }
    return '';
  };

  const apiKey = String(pick('API_KEY', 'ANTHROPIC_AUTH_TOKEN'));
  const baseUrlRaw = String(pick('BASE_URL', 'ANTHROPIC_BASE_URL') || 'https://api.anthropic.com');
  const baseUrl = normalizeBaseUrl(baseUrlRaw);

  let apiFormat = String(pick('API_FORMAT')).toLowerCase();
  if (apiFormat !== 'anthropic' && apiFormat !== 'openai') {
    let host = '';
    try { host = new URL(baseUrl).host; } catch (_) { /* ignore */ }
    apiFormat = host === 'api.anthropic.com' ? 'anthropic' : 'openai';
  }

  let authHeader = String(pick('AUTH_HEADER')).toLowerCase();
  if (authHeader !== 'bearer' && authHeader !== 'x-api-key') {
    authHeader = apiFormat === 'openai' ? 'bearer' : 'x-api-key';
  }

  if (!apiKey || apiKey === 'isi-token-anda-di-sini' || apiKey.startsWith('sk-ant-xxxx')) {
    throw new Error(
      'API_KEY belum diisi. Set environment variable API_KEY di Vercel ' +
      '(Settings → Environment Variables), atau isi nilai API_KEY di api/keys.env.'
    );
  }

  return { apiKey, baseUrl, authHeader, apiFormat };
}

/** Konfigurasi non-secret. Sama dengan api/config.example.php — JS port. */
function loadConfig() {
  return {
    default_model: 'claude-opus-4.6',
    allowed_models: {
      'claude-opus-4.6': 'Claude Opus 4.6',
      'claude-sonnet-4-5': 'Claude Sonnet 4.5',
      'claude-opus-4-5': 'Claude Opus 4.5',
      'claude-haiku-4-5': 'Claude Haiku 4.5',
      'claude-3-5-sonnet-latest': 'Claude 3.5 Sonnet',
      'claude-3-5-haiku-latest': 'Claude 3.5 Haiku',
    },
    system_prompt:
      'You are a helpful, concise assistant. Reply in the same language as the user.',
    max_tokens: 1024,
    timeout_ms: 60_000,
    anthropic_version: '2023-06-01',
  };
}

/**
 * Vercel parses application/json and application/x-www-form-urlencoded
 * automatically into req.body. For form-encoded with `data=<json>`, we
 * still need to JSON.parse the inner string.
 */
function readBody(req) {
  const b = req.body;
  if (b == null) return null;
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch (_) { return null; }
  }
  if (typeof b === 'object') {
    if (typeof b.data === 'string') {
      try { return JSON.parse(b.data); } catch (_) { return null; }
    }
    return b;
  }
  return null;
}

function jsonError(res, status, message) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify({ ok: false, error: message }));
}

module.exports = {
  parseEnvFile,
  normalizeBaseUrl,
  loadCredentials,
  loadConfig,
  readBody,
  jsonError,
};
