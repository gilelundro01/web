// Helper bersama untuk Vercel serverless functions.
//
// Berisi:
//   - Loader kredensial (env > keys.env)
//   - Body parser (JSON / form-encoded `data=`)
//   - Cookie reader/writer (anonymous user UID via cookie)
//   - Vercel KV (Upstash) REST helper + fallback in-memory (dev)
//   - Conversation CRUD (storage layer untuk chat history)
//   - Attachment validation & formatter (image / file → multimodal payload)

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ========================================================================
 * Env / config
 * ====================================================================== */

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
      if ((f === '"' && l === '"') || (f === "'" && l === "'")) val = val.slice(1, -1);
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
    // Attachment limits
    max_attachments_per_message: 6,
    max_attachment_bytes: 5 * 1024 * 1024,    // 5MB per file
    max_total_attachment_bytes: 12 * 1024 * 1024,
    // Conversation limits
    max_conversations_per_user: 200,
    max_messages_per_conversation: 200,
  };
}

/* ========================================================================
 * Body parsing
 * ====================================================================== */

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

/* ========================================================================
 * Response helpers
 * ====================================================================== */

function jsonError(res, status, message) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, error: message }));
}

function jsonOk(res, payload) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(Object.assign({ ok: true }, payload || {})));
}

/* ========================================================================
 * Cookie / anonymous user UID
 * ====================================================================== */

const COOKIE_NAME = 'chatuid';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 2; // 2 years

function parseCookies(req) {
  const out = {};
  const raw = req.headers && req.headers.cookie;
  if (!raw) return out;
  for (const part of String(raw).split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function appendSetCookie(res, cookieStr) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) {
    res.setHeader('Set-Cookie', cookieStr);
    return;
  }
  const arr = Array.isArray(prev) ? prev.slice() : [String(prev)];
  arr.push(cookieStr);
  res.setHeader('Set-Cookie', arr);
}

/**
 * Resolve (or assign) an anonymous user ID via cookie.
 * Returns { uid, isNew }. If isNew, also writes Set-Cookie header on `res`.
 */
function ensureUid(req, res) {
  const cookies = parseCookies(req);
  let uid = cookies[COOKIE_NAME];
  let isNew = false;
  if (!uid || !/^u_[A-Za-z0-9_-]{16,64}$/.test(uid)) {
    uid = 'u_' + crypto.randomBytes(18).toString('base64url');
    isNew = true;
    const parts = [
      `${COOKIE_NAME}=${encodeURIComponent(uid)}`,
      'Path=/',
      `Max-Age=${COOKIE_MAX_AGE}`,
      'SameSite=Lax',
      // HttpOnly so JS can't read it (still sent on fetch via credentials).
      'HttpOnly',
    ];
    // Secure when behind HTTPS (Vercel sets x-forwarded-proto=https).
    const proto = (req.headers && (req.headers['x-forwarded-proto'] || req.headers['x-forwarded-protocol'])) || '';
    if (String(proto).toLowerCase().includes('https')) parts.push('Secure');
    appendSetCookie(res, parts.join('; '));
  }
  return { uid, isNew };
}

/* ========================================================================
 * Vercel KV / Upstash Redis REST client
 * Falls back to in-memory Map if KV env vars are missing (local dev).
 * ====================================================================== */

let _memoryStore = null;
function memStore() {
  if (!_memoryStore) {
    _memoryStore = new Map();
    // Persist on global so HMR / multiple requires share.
    if (typeof globalThis.__chatMemStore !== 'undefined') {
      _memoryStore = globalThis.__chatMemStore;
    } else {
      globalThis.__chatMemStore = _memoryStore;
    }
  }
  return _memoryStore;
}

function kvConfigured() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function kvCmd(args) {
  if (!kvConfigured()) {
    // In-memory fallback for local dev only.
    return memCmd(args);
  }
  const url = process.env.KV_REST_API_URL.replace(/\/+$/, '');
  const token = process.env.KV_REST_API_TOKEN;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`KV HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data && data.error) throw new Error('KV error: ' + data.error);
  return data ? data.result : null;
}

function memCmd(args) {
  const store = memStore();
  const cmd = String(args[0] || '').toUpperCase();
  if (cmd === 'GET') {
    const v = store.get(args[1]);
    return v == null ? null : v;
  }
  if (cmd === 'SET') {
    store.set(args[1], String(args[2]));
    return 'OK';
  }
  if (cmd === 'DEL') {
    let n = 0;
    for (let i = 1; i < args.length; i++) {
      if (store.delete(args[i])) n += 1;
    }
    return n;
  }
  throw new Error('memCmd: command tidak didukung: ' + cmd);
}

async function kvGetJson(key) {
  const raw = await kvCmd(['GET', key]);
  if (raw == null) return null;
  try { return JSON.parse(String(raw)); } catch (_) { return null; }
}

async function kvSetJson(key, value) {
  return kvCmd(['SET', key, JSON.stringify(value)]);
}

async function kvDel(key) {
  return kvCmd(['DEL', key]);
}

/* ========================================================================
 * Conversation CRUD (KV)
 * Schema:
 *   u:<uid>          → { convs: [{id, title, updatedAt, model}, ...] }
 *   c:<convid>       → { id, ownerUid, title, model, createdAt, updatedAt,
 *                        messages: [{role, content, attachments?, ts}] }
 * ====================================================================== */

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(12).toString('base64url');
}

function userKey(uid) { return 'u:' + uid; }
function convKey(id)  { return 'c:' + id; }

async function getUserIndex(uid) {
  const idx = await kvGetJson(userKey(uid));
  if (!idx || !Array.isArray(idx.convs)) return { convs: [] };
  return idx;
}

async function setUserIndex(uid, idx) {
  return kvSetJson(userKey(uid), idx);
}

async function getConversation(id) {
  return kvGetJson(convKey(id));
}

async function setConversation(conv) {
  return kvSetJson(convKey(conv.id), conv);
}

async function deleteConversation(id) {
  return kvDel(convKey(id));
}

/**
 * List conversations for a user, sorted by updatedAt desc.
 * Returns shallow summaries (no message bodies).
 */
async function listConversations(uid) {
  const idx = await getUserIndex(uid);
  const summaries = idx.convs.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return summaries.map(c => ({
    id: c.id,
    title: c.title || 'Chat baru',
    updatedAt: c.updatedAt || 0,
    model: c.model || null,
  }));
}

async function createConversation(uid, opts = {}) {
  const cfg = loadConfig();
  const idx = await getUserIndex(uid);

  // Enforce per-user cap: if exceeded, drop oldest.
  while (idx.convs.length >= (cfg.max_conversations_per_user || 200)) {
    const oldest = idx.convs.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))[0];
    if (!oldest) break;
    idx.convs = idx.convs.filter(c => c.id !== oldest.id);
    try { await deleteConversation(oldest.id); } catch (_) { /* best effort */ }
  }

  const now = Date.now();
  const id = newId('c');
  const conv = {
    id,
    ownerUid: uid,
    title: String(opts.title || 'Chat baru').slice(0, 80) || 'Chat baru',
    model: opts.model || null,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  await setConversation(conv);

  idx.convs.push({ id, title: conv.title, updatedAt: now, model: conv.model });
  await setUserIndex(uid, idx);

  return conv;
}

async function appendMessages(uid, convId, newMessages, meta = {}) {
  const cfg = loadConfig();
  const conv = await getConversation(convId);
  if (!conv) throw new Error('Conversation tidak ditemukan: ' + convId);
  if (conv.ownerUid && conv.ownerUid !== uid) throw new Error('Akses ditolak.');

  conv.messages.push(...newMessages);
  // Trim oldest if too long.
  const cap = cfg.max_messages_per_conversation || 200;
  if (conv.messages.length > cap) {
    conv.messages = conv.messages.slice(conv.messages.length - cap);
  }

  conv.updatedAt = Date.now();
  if (meta.title && !conv.titleLocked) conv.title = String(meta.title).slice(0, 80);
  if (meta.titleLocked) conv.titleLocked = true;
  if (meta.model) conv.model = meta.model;

  await setConversation(conv);

  // Update index entry.
  const idx = await getUserIndex(uid);
  let entry = idx.convs.find(c => c.id === convId);
  if (!entry) {
    entry = { id: convId, title: conv.title, updatedAt: conv.updatedAt, model: conv.model };
    idx.convs.push(entry);
  } else {
    entry.title = conv.title;
    entry.updatedAt = conv.updatedAt;
    entry.model = conv.model;
  }
  await setUserIndex(uid, idx);

  return conv;
}

async function deleteUserConversation(uid, convId) {
  const conv = await getConversation(convId);
  if (conv && conv.ownerUid && conv.ownerUid !== uid) throw new Error('Akses ditolak.');
  await deleteConversation(convId);
  const idx = await getUserIndex(uid);
  idx.convs = idx.convs.filter(c => c.id !== convId);
  await setUserIndex(uid, idx);
}

async function renameUserConversation(uid, convId, title) {
  const conv = await getConversation(convId);
  if (!conv) throw new Error('Conversation tidak ditemukan');
  if (conv.ownerUid && conv.ownerUid !== uid) throw new Error('Akses ditolak.');
  conv.title = String(title || '').slice(0, 80) || 'Chat';
  conv.titleLocked = true; // user explicitly named it; don't auto-overwrite
  conv.updatedAt = Date.now();
  await setConversation(conv);
  const idx = await getUserIndex(uid);
  const e = idx.convs.find(c => c.id === convId);
  if (e) { e.title = conv.title; e.updatedAt = conv.updatedAt; }
  await setUserIndex(uid, idx);
  return conv;
}

/* ========================================================================
 * Attachments → upstream payload
 * Frontend mengirim setiap attachment sebagai:
 *   { kind: 'image' | 'file', name, mime, data: '<base64-without-prefix>' }
 * (atau dataUrl penuh — kita normalisasi).
 * ====================================================================== */

const SUPPORTED_IMAGE_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
]);

function normalizeAttachment(a) {
  if (!a || typeof a !== 'object') return null;
  const name = String(a.name || 'file').slice(0, 200);
  let mime = String(a.mime || '').toLowerCase().split(';')[0].trim();
  let data = String(a.data || '');
  // Strip data URL prefix if present.
  const dm = /^data:([^;,]+)(;base64)?,/.exec(data);
  if (dm) {
    if (!mime) mime = dm[1];
    data = data.slice(dm[0].length);
  }
  let kind = String(a.kind || '').toLowerCase();
  if (kind !== 'image' && kind !== 'file') {
    kind = mime.startsWith('image/') ? 'image' : 'file';
  }
  // For files, allow text content directly (no base64) under .text
  let text = typeof a.text === 'string' ? a.text : null;
  return { kind, name, mime, data, text };
}

function approxBase64Bytes(b64) {
  if (!b64) return 0;
  // Base64 expands by ~4/3
  return Math.floor(b64.length * 0.75);
}

function validateAttachments(rawList) {
  const cfg = loadConfig();
  if (!Array.isArray(rawList) || rawList.length === 0) return [];
  if (rawList.length > cfg.max_attachments_per_message) {
    throw new Error(`Maksimum ${cfg.max_attachments_per_message} attachment per pesan.`);
  }
  let total = 0;
  const out = [];
  for (const r of rawList) {
    const a = normalizeAttachment(r);
    if (!a) continue;
    if (a.kind === 'image') {
      if (!SUPPORTED_IMAGE_MIME.has(a.mime)) {
        throw new Error(`Gambar tidak didukung: ${a.mime || '?'}. Pakai jpeg/png/gif/webp.`);
      }
      const sz = approxBase64Bytes(a.data);
      if (sz > cfg.max_attachment_bytes) {
        throw new Error(`Gambar terlalu besar (>${Math.round(cfg.max_attachment_bytes/1024/1024)}MB): ${a.name}`);
      }
      total += sz;
    } else {
      const sz = a.text != null ? a.text.length : approxBase64Bytes(a.data);
      if (sz > cfg.max_attachment_bytes) {
        throw new Error(`File terlalu besar: ${a.name}`);
      }
      total += sz;
    }
    out.push(a);
  }
  if (total > cfg.max_total_attachment_bytes) {
    throw new Error('Total attachment terlalu besar.');
  }
  return out;
}

/**
 * Convert a stored message ({role, content, attachments?}) into the upstream
 * payload format expected by `apiFormat`.
 *
 * For a user message with attachments:
 *   - openai-compat: content = [{type:"text",text}, {type:"image_url",image_url:{url:"data:..."}}, ...]
 *   - anthropic:     content = [{type:"text",text}, {type:"image",source:{type:"base64",media_type,data}}, ...]
 *
 * Files (non-image): inlined into the text portion so the model can read them.
 */
function buildUpstreamMessage(msg, apiFormat) {
  const role = msg.role;
  const baseText = String(msg.content || '');
  const atts = Array.isArray(msg.attachments) ? msg.attachments : [];

  if (atts.length === 0) {
    return { role, content: baseText };
  }

  // Inline file/text attachments into text portion.
  const fileBlobs = atts.filter(a => a.kind !== 'image' && (a.text || a.data));
  let combinedText = baseText;
  if (fileBlobs.length > 0) {
    const parts = [baseText];
    for (const f of fileBlobs) {
      const body = f.text != null
        ? f.text
        : (() => {
            try { return Buffer.from(f.data, 'base64').toString('utf8'); }
            catch (_) { return '(unreadable binary)'; }
          })();
      parts.push(`\n\n[File: ${f.name}]\n\`\`\`\n${body.slice(0, 32_000)}\n\`\`\``);
    }
    combinedText = parts.join('');
  }

  const images = atts.filter(a => a.kind === 'image' && a.data);

  if (images.length === 0) {
    return { role, content: combinedText };
  }

  if (apiFormat === 'openai') {
    const blocks = [];
    if (combinedText) blocks.push({ type: 'text', text: combinedText });
    for (const im of images) {
      blocks.push({
        type: 'image_url',
        image_url: { url: `data:${im.mime};base64,${im.data}` },
      });
    }
    return { role, content: blocks };
  }

  // anthropic
  const blocks = [];
  if (combinedText) blocks.push({ type: 'text', text: combinedText });
  for (const im of images) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: im.mime, data: im.data },
    });
  }
  return { role, content: blocks };
}

/**
 * Convert stored history into upstream messages array.
 * Drops messages with empty content & no attachments.
 */
function buildUpstreamMessages(messages, apiFormat) {
  const out = [];
  for (const m of messages || []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = m.content || '';
    const hasAtt = Array.isArray(m.attachments) && m.attachments.length > 0;
    if (!content && !hasAtt) continue;
    out.push(buildUpstreamMessage(m, apiFormat));
  }
  return out;
}

/* ========================================================================
 * Misc
 * ====================================================================== */

function makeTitleFromMessage(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'Chat baru';
  return t.length > 60 ? t.slice(0, 60) + '…' : t;
}

module.exports = {
  // env + config
  parseEnvFile, normalizeBaseUrl, loadCredentials, loadConfig,
  // body
  readBody,
  // response
  jsonError, jsonOk,
  // cookies
  parseCookies, ensureUid,
  // kv
  kvConfigured, kvCmd, kvGetJson, kvSetJson, kvDel,
  // conversations
  newId, listConversations, getConversation, createConversation,
  appendMessages, deleteUserConversation, renameUserConversation,
  // attachments
  validateAttachments, buildUpstreamMessage, buildUpstreamMessages,
  // misc
  makeTitleFromMessage,
};
