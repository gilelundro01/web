// Vercel serverless function: live-streaming proxy ke Claude API.
// Mendukung dual format (anthropic-native /v1/messages atau OpenAI-compat
// /v1/chat/completions) dan selalu stream Server-Sent Events ke client.
//
// Input (POST):
//   - application/json     : { model?, messages: [{role, content}, ...] }
//   - application/x-www-form-urlencoded : data=<json string di atas>
//
// Output: SSE stream
//   data: {"delta":"...kata..."}\n\n     (banyak, satu per chunk)
//   data: {"done":true,"model":"...","usage":{...}}\n\n   (terakhir)
//   data: {"error":"pesan"}\n\n           (kalau gagal di tengah jalan)
//
// Frontend: assets/app.js membaca stream ini dan update DOM kata-per-kata.

'use strict';

const { loadCredentials, loadConfig, readBody, jsonError } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return jsonError(res, 405, 'Method not allowed');
  }

  let creds;
  try {
    creds = loadCredentials();
  } catch (e) {
    return jsonError(res, 500, e.message || String(e));
  }
  const config = loadConfig();

  const body = readBody(req);
  if (!body || typeof body !== 'object') {
    return jsonError(res, 400, 'Body harus JSON (atau form-encoded data=<json>).');
  }

  const messagesIn = Array.isArray(body.messages) ? body.messages : null;
  if (!messagesIn || messagesIn.length === 0) {
    return jsonError(res, 400, 'Field "messages" wajib dan tidak boleh kosong.');
  }

  const cleanMessages = [];
  for (const m of messagesIn) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    const content = m.content;
    if (role !== 'user' && role !== 'assistant') continue;
    if (typeof content !== 'string' || content.trim() === '') continue;
    cleanMessages.push({ role, content });
  }
  if (cleanMessages.length === 0) {
    return jsonError(res, 400, 'Tidak ada pesan valid.');
  }

  const allowed = config.allowed_models || {};
  const requestedModel = typeof body.model === 'string' ? body.model : '';
  const model = allowed[requestedModel] ? requestedModel : config.default_model;

  const systemPrompt = String(config.system_prompt || '');
  const maxTokens = Number(config.max_tokens || 1024);

  // SSE response setup. Vercel & most reverse proxies disable buffering
  // when Content-Type is text/event-stream + X-Accel-Buffering: no.
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  function sse(obj) {
    res.write('data: ' + JSON.stringify(obj) + '\n\n');
  }

  // Initial comment so client knows headers are flushed.
  res.write(': stream-start\n\n');

  const ac = new AbortController();
  let aborted = false;
  req.on('close', () => { aborted = true; ac.abort(); });
  const timer = setTimeout(() => ac.abort(), Number(config.timeout_ms || 60_000));

  let totalText = '';
  let modelOut = null;
  let usage = null;

  try {
    let url;
    let headers;
    let payload;

    if (creds.apiFormat === 'openai') {
      url = creds.baseUrl + '/v1/chat/completions';
      headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + creds.apiKey,
        'Accept': 'text/event-stream',
      };
      const oaMessages = [];
      if (systemPrompt) oaMessages.push({ role: 'system', content: systemPrompt });
      for (const m of cleanMessages) oaMessages.push(m);
      payload = {
        model,
        messages: oaMessages,
        max_tokens: maxTokens,
        stream: true,
      };
    } else {
      // Anthropic-native streaming.
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
      payload = {
        model,
        max_tokens: maxTokens,
        messages: cleanMessages,
        stream: true,
      };
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
          // Anthropic event types: message_start, content_block_start,
          // content_block_delta, content_block_stop, message_delta, message_stop, ping
          if (evt.type === 'message_start' && evt.message?.model) {
            modelOut = evt.message.model;
            if (evt.message.usage) usage = evt.message.usage;
          } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            const t = String(evt.delta.text || '');
            if (t) {
              totalText += t;
              sse({ delta: t });
            }
          } else if (evt.type === 'message_delta' && evt.usage) {
            usage = { ...(usage || {}), ...evt.usage };
          }
        }
      }
    }

    if (!totalText && !aborted) {
      sse({ error: 'Upstream mengembalikan response kosong.' });
    } else if (!aborted) {
      sse({ done: true, model: modelOut || model, usage });
    }
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
