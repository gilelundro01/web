// Vercel serverless function: proxy ke Claude API (Anthropic atau OpenAI-compat).
// Setara dengan api/chat.php tapi runtime Node.js.
//
// Input (POST):
//   - application/json     : { model?, messages: [{role, content}, ...] }
//   - application/x-www-form-urlencoded : data=<json string di atas>
//
// Output:
//   sukses: { ok: true,  reply: "...", model: "...", usage?: {...} }
//   error : { ok: false, error: "pesan error" }

'use strict';

const { loadCredentials, loadConfig, readBody, jsonError } = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

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

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(config.timeout_ms || 60_000));

  try {
    if (creds.apiFormat === 'openai') {
      // OpenAI-compat (ecomagent dll): pakai stream=true, assemble SSE.
      // Ecomagent kembalikan content:null di non-streaming — wajib stream.
      const url = creds.baseUrl + '/v1/chat/completions';
      const oaMessages = [];
      if (systemPrompt) oaMessages.push({ role: 'system', content: systemPrompt });
      for (const m of cleanMessages) oaMessages.push(m);

      const upstream = await fetch(url, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + creds.apiKey,
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({
          model,
          messages: oaMessages,
          max_tokens: maxTokens,
          stream: true,
        }),
      });

      if (!upstream.ok) {
        const txt = await upstream.text().catch(() => '');
        let msg = null;
        try {
          const j = JSON.parse(txt);
          msg = j?.error?.message || j?.error || j?.message || null;
        } catch (_) { /* ignore */ }
        return jsonError(res, upstream.status, msg || ('HTTP ' + upstream.status));
      }

      let content = '';
      let buffer = '';
      let usage = null;
      let modelOut = null;

      const decoder = new TextDecoder();
      const reader = upstream.body?.getReader();
      if (!reader) {
        return jsonError(res, 502, 'Upstream tidak mengembalikan body stream.');
      }
      while (true) {
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
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let evt;
          try { evt = JSON.parse(payload); } catch (_) { continue; }
          if (typeof evt?.model === 'string') modelOut = evt.model;
          if (evt?.usage && typeof evt.usage === 'object') usage = evt.usage;
          const delta = evt?.choices?.[0]?.delta;
          if (delta && typeof delta.content === 'string') {
            content += delta.content;
          }
        }
      }

      if (!content) {
        return jsonError(res, 502, 'Upstream mengembalikan response kosong.');
      }

      res.status(200).setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.send(JSON.stringify({
        ok: true,
        reply: content,
        model: modelOut || model,
        usage,
      }));
    }

    // Anthropic native.
    const url = creds.baseUrl + '/v1/messages';
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': config.anthropic_version || '2023-06-01',
    };
    if (creds.authHeader === 'bearer') {
      headers['Authorization'] = 'Bearer ' + creds.apiKey;
    } else {
      headers['x-api-key'] = creds.apiKey;
    }

    const payload = {
      model,
      max_tokens: maxTokens,
      messages: cleanMessages,
    };
    if (systemPrompt) payload.system = systemPrompt;

    const upstream = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers,
      body: JSON.stringify(payload),
    });
    const txt = await upstream.text();
    let data = null;
    try { data = JSON.parse(txt); } catch (_) { /* ignore */ }
    if (!data) {
      return jsonError(res, 502, 'Response API bukan JSON valid.');
    }
    if (!upstream.ok) {
      const msg = data?.error?.message || (typeof data?.error === 'string' ? data.error : null) || data?.message || ('HTTP ' + upstream.status);
      return jsonError(res, upstream.status, String(msg));
    }
    let reply = '';
    for (const block of (data.content || [])) {
      if (block?.type === 'text') reply += String(block.text || '');
    }
    res.status(200).setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.send(JSON.stringify({
      ok: true,
      reply,
      model: data.model || model,
      usage: data.usage || null,
    }));
  } catch (e) {
    if (e?.name === 'AbortError') {
      return jsonError(res, 504, 'Timeout: API tidak merespon dalam batas waktu.');
    }
    return jsonError(res, 502, 'Gagal menghubungi API: ' + (e?.message || String(e)));
  } finally {
    clearTimeout(timer);
  }
};
