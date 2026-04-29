// Vercel serverless function: live-streaming proxy ke Claude API + persist
// chat history ke Vercel KV.
//
// Input (POST):
//   - application/json     : {
//       conversationId: "c_xxx",
//       message: { content: "string", attachments?: [{kind,name,mime,data}] },
//       model?: "claude-..."
//     }
//   - application/x-www-form-urlencoded : data=<json string di atas>
//
// Output: SSE stream
//   data: {"delta":"..."}\n\n
//   data: {"done":true,"conversationId":"...","model":"...","usage":{...},"title":"..."}\n\n
//   data: {"error":"pesan"}\n\n
//
// History flow:
//   - Server resolves uid via cookie (anonymous, persistent).
//   - Loads conversation from KV (must belong to uid).
//   - Appends user message (with attachments) to KV before calling upstream.
//   - Streams response, accumulating text.
//   - On completion, appends assistant message to KV.
//
// Backwards compat: if body has `messages: [...]` (legacy stateless mode) and
// no `conversationId`, we create a new conversation automatically.

'use strict';

const {
  loadCredentials, loadConfig,
  readBody,
  jsonError,
  ensureUid,
  getConversation, createConversation, appendMessages,
  validateAttachments, buildUpstreamMessages, makeTitleFromMessage,
} = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return jsonError(res, 405, 'Method not allowed');
  }

  let creds;
  try { creds = loadCredentials(); }
  catch (e) { return jsonError(res, 500, e.message || String(e)); }
  const config = loadConfig();

  const body = readBody(req);
  if (!body || typeof body !== 'object') {
    return jsonError(res, 400, 'Body harus JSON (atau form-encoded data=<json>).');
  }

  const { uid } = ensureUid(req, res);

  // ---- Resolve / create conversation -----------------------------------

  let conversationId = typeof body.conversationId === 'string' ? body.conversationId : '';
  let conversation = null;

  if (conversationId) {
    conversation = await getConversation(conversationId);
    if (!conversation) return jsonError(res, 404, 'Conversation tidak ditemukan.');
    if (conversation.ownerUid && conversation.ownerUid !== uid) {
      return jsonError(res, 403, 'Akses ditolak.');
    }
  }

  // ---- Resolve incoming user message + attachments ---------------------

  let userMsgText = '';
  let userAttachments = [];

  if (body.message && typeof body.message === 'object') {
    userMsgText = String(body.message.content || '').trim();
    try {
      userAttachments = validateAttachments(body.message.attachments || []);
    } catch (e) {
      return jsonError(res, 400, e.message || String(e));
    }
  } else if (Array.isArray(body.messages)) {
    // Legacy compat: stateless `messages` array (one-shot, no persistence).
    // Take the last user msg as this turn; the rest become initial context.
    const arr = body.messages;
    let last = null;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] && arr[i].role === 'user') { last = arr[i]; break; }
    }
    if (last) userMsgText = String(last.content || '').trim();
  }

  if (!userMsgText && userAttachments.length === 0) {
    return jsonError(res, 400, 'Pesan kosong (tidak ada teks atau attachment).');
  }

  if (!conversation) {
    // Always create a new conversation. If Vercel KV is not configured,
    // _lib falls back to in-memory store (works for dev, but persistence
    // across Vercel cold starts requires real KV setup).
    conversation = await createConversation(uid, {
      title: makeTitleFromMessage(userMsgText),
      model: typeof body.model === 'string' ? body.model : null,
    });
    conversationId = conversation.id;

    // Legacy support: caller passed full `messages` array (stateless mode).
    // Pre-load earlier turns into the new conversation so context is preserved.
    if (Array.isArray(body.messages) && body.messages.length > 0) {
      const arr = body.messages
        .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
        .slice(0, -1)  // last user msg comes via `userMsgText` below; don't duplicate
        .map(m => ({ role: m.role, content: String(m.content || '') }));
      conversation.messages.push(...arr);
    }
  }

  // Append user message to in-memory conversation (we'll persist to KV later
  // alongside the assistant reply so a single SET both creates & finalises
  // the turn — saves a round-trip).
  if (userMsgText || userAttachments.length > 0) {
    conversation.messages.push({
      role: 'user',
      content: userMsgText,
      attachments: userAttachments.length ? userAttachments : undefined,
      ts: Date.now(),
    });
  }

  // ---- Resolve model ---------------------------------------------------

  const allowed = config.allowed_models || {};
  const requestedModel = typeof body.model === 'string'
    ? body.model
    : (conversation.model || '');
  const model = allowed[requestedModel] ? requestedModel : config.default_model;

  const systemPrompt = String(config.system_prompt || '');
  const maxTokens = Number(config.max_tokens || 1024);

  // ---- Build upstream messages -----------------------------------------

  const upstreamMsgs = buildUpstreamMessages(conversation.messages, creds.apiFormat);
  if (upstreamMsgs.length === 0) {
    return jsonError(res, 400, 'Tidak ada pesan valid untuk dikirim.');
  }

  // ---- SSE response setup ----------------------------------------------

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  function sse(obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
  res.write(': stream-start\n\n');

  // Send conversationId early so client can store it before stream ends.
  if (conversationId) sse({ conversationId });

  const ac = new AbortController();
  let aborted = false;
  req.on('close', () => { aborted = true; ac.abort(); });
  const timer = setTimeout(() => ac.abort(), Number(config.timeout_ms || 60_000));

  let totalText = '';
  let modelOut = null;
  let usage = null;

  try {
    let url, headers, payload;

    if (creds.apiFormat === 'openai') {
      url = creds.baseUrl + '/v1/chat/completions';
      headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + creds.apiKey,
        'Accept': 'text/event-stream',
      };
      const oaMessages = [];
      if (systemPrompt) oaMessages.push({ role: 'system', content: systemPrompt });
      for (const m of upstreamMsgs) oaMessages.push(m);
      payload = { model, messages: oaMessages, max_tokens: maxTokens, stream: true };
    } else {
      url = creds.baseUrl + '/v1/messages';
      headers = {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'anthropic-version': config.anthropic_version || '2023-06-01',
      };
      if (creds.authHeader === 'bearer') {
        headers['Authorization'] = 'Bearer ' + creds.apiKey;
      } else {
        headers['x-api-key'] = creds.apiKey;
      }
      payload = { model, max_tokens: maxTokens, messages: upstreamMsgs, stream: true };
      if (systemPrompt) payload.system = systemPrompt;
    }

    const upstream = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers,
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => '');
      let msg = null;
      try {
        const j = JSON.parse(txt);
        msg = j?.error?.message || j?.error || j?.message || null;
      } catch (_) { /* ignore */ }
      sse({ error: msg || ('HTTP ' + upstream.status) });
      res.end();
      return;
    }

    const decoder = new TextDecoder();
    const reader = upstream.body?.getReader();
    if (!reader) {
      sse({ error: 'Upstream tidak mengembalikan body stream.' });
      res.end();
      return;
    }

    let buffer = '';
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        line = line.replace(/\r$/, '');
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(data); } catch (_) { continue; }

        if (creds.apiFormat === 'openai') {
          if (typeof evt.model === 'string') modelOut = evt.model;
          if (evt.usage && typeof evt.usage === 'object') usage = evt.usage;
          const delta = evt?.choices?.[0]?.delta;
          if (delta && typeof delta.content === 'string' && delta.content) {
            totalText += delta.content;
            sse({ delta: delta.content });
          }
        } else {
          if (evt.type === 'message_start' && evt.message?.model) {
            modelOut = evt.message.model;
            if (evt.message.usage) usage = evt.message.usage;
          } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            const t = String(evt.delta.text || '');
            if (t) { totalText += t; sse({ delta: t }); }
          } else if (evt.type === 'message_delta' && evt.usage) {
            usage = { ...(usage || {}), ...evt.usage };
          }
        }
      }
    }

    if (!totalText && !aborted) {
      sse({ error: 'Upstream mengembalikan response kosong.' });
      res.end();
      return;
    }

    if (aborted) {
      try { res.end(); } catch (_) { /* socket closed */ }
      return;
    }

    // ---- Persist turn to KV --------------------------------------------
    let savedTitle = conversation.title;
    if (conversationId) {
      try {
        const userMsg = conversation.messages[conversation.messages.length - 1];
        const newMessages = [];
        // userMsg already accounted for in conversation.messages above; persist
        // both user + assistant in one append. But our in-memory convo already
        // pushed userMsg, so we re-push it to KV via appendMessages. We have
        // to reload from KV to avoid double-adding.
        // Simplest: call appendMessages with [userMsg, assistantMsg]. KV cap
        // logic in appendMessages will handle trimming.
        if (userMsg && (userMsg.content || (userMsg.attachments && userMsg.attachments.length))) {
          newMessages.push(userMsg);
        }
        newMessages.push({
          role: 'assistant',
          content: totalText,
          ts: Date.now(),
        });
        // First message? auto-title from user content.
        const meta = { model: modelOut || model };
        const conv = await getConversation(conversationId);
        if (conv && conv.messages.length === 0) {
          const titleSrc = userMsg ? userMsg.content : '';
          if (titleSrc) meta.title = makeTitleFromMessage(titleSrc);
        }
        const updated = await appendMessages(uid, conversationId, newMessages, meta);
        savedTitle = updated.title;
      } catch (e) {
        // Don't fail the response on persistence error; just notify.
        sse({ warning: 'Gagal simpan ke KV: ' + (e.message || String(e)) });
      }
    }

    sse({
      done: true,
      model: modelOut || model,
      usage,
      conversationId: conversationId || null,
      title: savedTitle,
    });
    res.end();
  } catch (e) {
    if (!aborted) {
      const msg = e?.name === 'AbortError'
        ? 'Timeout: API tidak merespon dalam batas waktu.'
        : 'Gagal menghubungi API: ' + (e?.message || String(e));
      try { sse({ error: msg }); } catch (_) { /* socket may be closed */ }
    }
    try { res.end(); } catch (_) { /* ignore */ }
  } finally {
    clearTimeout(timer);
  }
};
