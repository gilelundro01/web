(() => {
  'use strict';

  /* ============================================================
   * Element refs
   * ============================================================ */
  const $chat       = document.getElementById('chat');
  const $form       = document.getElementById('composer');
  const $input      = document.getElementById('input');
  const $send       = document.getElementById('send-btn');
  const $modelSel   = document.getElementById('model');
  const $convList   = document.getElementById('conv-list');
  const $newChat    = document.getElementById('new-chat-btn');
  const $newChatMob = document.getElementById('new-chat-mobile');
  const $sidebar    = document.getElementById('sidebar');
  const $sbToggle   = document.getElementById('sidebar-toggle');
  const $sbClose    = document.getElementById('sidebar-close');
  const $sbBackdrop = document.getElementById('sidebar-backdrop');
  const $attachBtn  = document.getElementById('attach-btn');
  const $fileInput  = document.getElementById('file-input');
  const $attachBar  = document.getElementById('attachments-bar');

  const MODEL_KEY = 'claude-chat-model-v1';

  /** @type {{role:string, content:string, attachments?:any[]}[]} */
  let messages = [];
  /** @type {{id:string,title:string,updatedAt:number,model?:string|null}[]} */
  let conversations = [];
  /** @type {string|null} */
  let currentConvId = null;
  /** @type {{kind:string,name:string,mime:string,data?:string,text?:string,previewUrl?:string}[]} */
  let pendingAttachments = [];
  let isSending = false;

  /* ============================================================
   * Markdown renderer (with code-block tagging for hljs)
   * ============================================================ */
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    })[c]);
  }

  function renderInline(text) {
    let out = escapeHtml(text);
    const codeStubs = [];
    out = out.replace(/`([^`\n]+)`/g, (_, c) => {
      codeStubs.push(c);
      return `\u0000CODE${codeStubs.length - 1}\u0000`;
    });
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    out = out.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => `<code>${codeStubs[+i]}</code>`);
    return out;
  }

  function renderMarkdown(text) {
    if (!text) return '';
    const blocks = [];
    text = text.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_, lang, body) => {
      blocks.push({ lang, body });
      return `\u0000BLOCK${blocks.length - 1}\u0000`;
    });

    const lines = text.split('\n');
    const html = [];
    let buf = [];
    let mode = null;

    function flushBuf() {
      if (buf.length === 0) return;
      const joined = buf.join(' ').trim();
      if (joined) html.push(`<p>${renderInline(joined)}</p>`);
      buf = [];
    }
    function flushList() {
      if (mode === 'ul') html.push('</ul>');
      if (mode === 'ol') html.push('</ol>');
      if (mode === 'bq') html.push('</blockquote>');
      mode = null;
    }

    for (let raw of lines) {
      const line = raw.replace(/\s+$/, '');
      const blockMatch = line.match(/^\u0000BLOCK(\d+)\u0000$/);
      if (blockMatch) {
        flushBuf(); flushList();
        const { lang, body } = blocks[+blockMatch[1]];
        const langLabel = lang ? escapeHtml(lang) : 'plaintext';
        const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : '';
        // We render the code-block shell here. The copy button + hljs
        // application is handled post-render by `decorateCodeBlocks`.
        html.push(
          `<div class="code-block" data-lang="${langLabel}">` +
            `<div class="code-block-head">` +
              `<span class="code-block-lang">${langLabel}</span>` +
              `<button type="button" class="code-copy-btn" data-act="copy-code" title="Salin kode">` +
                `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>` +
                `<span>Copy</span>` +
              `</button>` +
            `</div>` +
            `<pre><code${langClass}>${escapeHtml(body.replace(/\n$/, ''))}</code></pre>` +
          `</div>`
        );
        continue;
      }
      if (line === '') { flushBuf(); flushList(); continue; }
      const h = line.match(/^(#{1,3})\s+(.+)$/);
      if (h) { flushBuf(); flushList();
        html.push(`<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`); continue; }
      const ul = line.match(/^\s*[-*]\s+(.+)$/);
      if (ul) { flushBuf();
        if (mode !== 'ul') { flushList(); html.push('<ul>'); mode = 'ul'; }
        html.push(`<li>${renderInline(ul[1])}</li>`); continue; }
      const ol = line.match(/^\s*\d+\.\s+(.+)$/);
      if (ol) { flushBuf();
        if (mode !== 'ol') { flushList(); html.push('<ol>'); mode = 'ol'; }
        html.push(`<li>${renderInline(ol[1])}</li>`); continue; }
      const bq = line.match(/^>\s?(.*)$/);
      if (bq) { flushBuf();
        if (mode !== 'bq') { flushList(); html.push('<blockquote>'); mode = 'bq'; }
        html.push(`<p>${renderInline(bq[1])}</p>`); continue; }
      if (mode) flushList();
      buf.push(line);
    }
    flushBuf(); flushList();
    return html.join('\n');
  }

  function decorateCodeBlocks(rootEl) {
    if (!rootEl) return;
    const blocks = rootEl.querySelectorAll('.code-block code');
    blocks.forEach(codeEl => {
      // Apply hljs if loaded.
      if (window.hljs && !codeEl.dataset.highlighted) {
        try { window.hljs.highlightElement(codeEl); } catch (_) { /* ignore */ }
        codeEl.dataset.highlighted = '1';
      }
    });
  }

  /* ============================================================
   * Empty state
   * ============================================================ */
  const SUGGESTIONS = [
    { title: 'Jelaskan konsep',  sub: 'Apa itu rate limiting dan kenapa penting?' },
    { title: 'Bantu coding',     sub: 'Buat fungsi PHP untuk validasi email' },
    { title: 'Brainstorm',       sub: '5 ide nama untuk kafe specialty coffee' },
    { title: 'Ringkas / terjemah', sub: 'Terjemahkan paragraf berikut ke Inggris…' },
  ];

  function renderEmpty() {
    const cards = SUGGESTIONS.map((s, i) => `
      <button type="button" class="suggestion" data-suggestion="${i}">
        <div class="s-title">${escapeHtml(s.title)}</div>
        <div class="s-sub">${escapeHtml(s.sub)}</div>
      </button>
    `).join('');
    $chat.innerHTML = `
      <div class="empty-state">
        <div class="empty-logo" aria-hidden="true"></div>
        <h2>Halo, mau ngobrol apa hari ini?</h2>
        <p>Tanya apa saja, atau coba salah satu ide di bawah.</p>
        <div class="suggestions">${cards}</div>
      </div>
    `;
    $chat.querySelectorAll('.suggestion').forEach(el => {
      el.addEventListener('click', () => {
        const idx = +el.getAttribute('data-suggestion');
        const s = SUGGESTIONS[idx];
        if (s) sendMessage(s.sub);
      });
    });
  }

  /* ============================================================
   * Messages
   * ============================================================ */
  function makeMsgEl(role, opts = {}) {
    const $msg = document.createElement('div');
    $msg.className = `msg ${role}` + (opts.error ? ' error' : '');
    const author = role === 'user' ? 'You' : 'Claude';
    const initial = role === 'user' ? 'Y' : 'C';
    $msg.innerHTML = `
      <div class="avatar">${initial}</div>
      <div class="msg-body">
        <div class="msg-author">${author}</div>
        <div class="msg-content"></div>
      </div>
    `;
    return $msg;
  }

  function renderAttachmentsInMsg($content, attachments) {
    if (!attachments || !attachments.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'msg-attachments';
    for (const a of attachments) {
      if (a.kind === 'image' && a.data) {
        const img = document.createElement('img');
        img.className = 'msg-att-image';
        img.src = `data:${a.mime || 'image/png'};base64,${a.data}`;
        img.alt = a.name || 'image';
        img.loading = 'lazy';
        wrap.appendChild(img);
      } else {
        const chip = document.createElement('div');
        chip.className = 'msg-att-file';
        chip.textContent = '📄 ' + (a.name || 'file');
        wrap.appendChild(chip);
      }
    }
    $content.appendChild(wrap);
  }

  function renderMsgContent($msg, role, content, attachments) {
    const $c = $msg.querySelector('.msg-content');
    $c.innerHTML = '';
    if (role === 'assistant') {
      const html = renderMarkdown(content || '');
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      while (tmp.firstChild) $c.appendChild(tmp.firstChild);
      decorateCodeBlocks($c);
    } else {
      const txt = document.createElement('div');
      txt.className = 'user-text';
      txt.innerHTML = escapeHtml(content || '').replace(/\n/g, '<br>');
      $c.appendChild(txt);
      renderAttachmentsInMsg($c, attachments);
    }
  }

  function appendMessage(role, content, opts = {}) {
    const $msg = makeMsgEl(role, opts);
    if (content || opts.attachments) renderMsgContent($msg, role, content, opts.attachments);
    $chat.appendChild($msg);
    scrollToBottom();
    return $msg;
  }

  function appendActions($msg, role) {
    if (role !== 'assistant') return;
    if ($msg.querySelector('.msg-actions')) return;
    const $body = $msg.querySelector('.msg-body');
    const $actions = document.createElement('div');
    $actions.className = 'msg-actions';
    $actions.innerHTML = `
      <button class="msg-action-btn" data-act="copy" title="Salin">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy
      </button>
      <button class="msg-action-btn" data-act="regen" title="Regenerate">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>
        Regenerate
      </button>
    `;
    $body.appendChild($actions);
  }

  function renderAll() {
    $chat.innerHTML = '';
    if (messages.length === 0) { renderEmpty(); return; }
    for (const m of messages) {
      const $msg = appendMessage(m.role, m.content, { attachments: m.attachments });
      if (m.role === 'assistant') appendActions($msg, m.role);
    }
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    });
  }

  /* ============================================================
   * Typing indicator (simple animated dots)
   * ============================================================ */
  function attachTypingIndicator($msg) {
    const $c = $msg.querySelector('.msg-content');
    const $dots = document.createElement('div');
    $dots.className = 'typing-dots';
    $dots.innerHTML = '<span class="d"></span><span class="d"></span><span class="d"></span>';
    $c.appendChild($dots);
    return {
      remove: () => { $dots.remove(); },
    };
  }

  /* ============================================================
   * Networking — conversations
   * ============================================================ */
  async function fetchJson(url, opts = {}) {
    const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts));
    const ct = res.headers.get('content-type') || '';
    if (!ct.startsWith('application/json')) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} (response bukan JSON): ${txt.slice(0, 80)}`);
    }
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function loadConversations() {
    try {
      const data = await fetchJson('api/conversations');
      conversations = data.conversations || [];
      renderConversationList();
      return true;
    } catch (e) {
      console.warn('loadConversations failed', e);
      conversations = [];
      renderConversationList();
      // Show friendly message in sidebar.
      $convList.innerHTML = `<div class="conv-empty">${escapeHtml(e.message)}</div>`;
      return false;
    }
  }

  async function loadConversation(id) {
    try {
      const data = await fetchJson('api/conversation?id=' + encodeURIComponent(id));
      currentConvId = data.conversation.id;
      messages = data.conversation.messages || [];
      if (data.conversation.model && $modelSel.querySelector(`option[value="${data.conversation.model}"]`)) {
        $modelSel.value = data.conversation.model;
      }
      renderAll();
      renderConversationList(); // re-mark active
      closeSidebarMobile();
    } catch (e) {
      alert('Gagal memuat: ' + e.message);
    }
  }

  async function deleteConversation(id) {
    if (!confirm('Hapus percakapan ini?')) return;
    try {
      await fetchJson('api/conversation?id=' + encodeURIComponent(id), { method: 'DELETE' });
      conversations = conversations.filter(c => c.id !== id);
      if (currentConvId === id) {
        currentConvId = null;
        messages = [];
        renderAll();
      }
      renderConversationList();
    } catch (e) {
      alert('Gagal hapus: ' + e.message);
    }
  }

  async function renameConversation(id, currentTitle) {
    const t = prompt('Ganti judul percakapan:', currentTitle || '');
    if (t == null || !t.trim()) return;
    try {
      await fetchJson('api/conversation?id=' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t.trim() }),
      });
      const c = conversations.find(c => c.id === id);
      if (c) c.title = t.trim();
      renderConversationList();
    } catch (e) {
      alert('Gagal rename: ' + e.message);
    }
  }

  function renderConversationList() {
    if (conversations.length === 0) {
      $convList.innerHTML = `<div class="conv-empty">Belum ada percakapan.</div>`;
      return;
    }
    $convList.innerHTML = conversations.map(c => `
      <div class="conv-item${c.id === currentConvId ? ' active' : ''}" data-id="${escapeHtml(c.id)}">
        <button type="button" class="conv-title" data-act="open" data-id="${escapeHtml(c.id)}" title="${escapeHtml(c.title)}">
          ${escapeHtml(c.title || 'Chat baru')}
        </button>
        <div class="conv-actions">
          <button type="button" class="conv-mini-btn" data-act="rename" data-id="${escapeHtml(c.id)}" title="Ganti judul" aria-label="Ganti judul">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
          <button type="button" class="conv-mini-btn" data-act="delete" data-id="${escapeHtml(c.id)}" title="Hapus" aria-label="Hapus">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    `).join('');
  }

  /* ============================================================
   * Networking — models
   * ============================================================ */
  async function loadModels() {
    try {
      const res = await fetch('api/models', { cache: 'no-store' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Gagal memuat model');
      const saved = localStorage.getItem(MODEL_KEY);
      $modelSel.innerHTML = '';
      const models = data.models || {};
      for (const [id, label] of Object.entries(models)) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = label;
        $modelSel.appendChild(opt);
      }
      const want = (saved && models[saved]) ? saved : data.default;
      if (want) $modelSel.value = want;
    } catch (e) {
      $modelSel.innerHTML = '<option>(default)</option>';
      $modelSel.disabled = true;
      console.warn('models load failed', e);
    }
  }

  /* ============================================================
   * Networking — chat (SSE streaming)
   * ============================================================ */
  async function streamChat(payload, onDelta) {
    const res = await fetch('api/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(JSON.stringify(payload)),
    });

    const ct = res.headers.get('content-type') || '';
    if (ct.startsWith('application/json')) {
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.ok) {
        throw new Error((data && data.error) || `HTTP ${res.status} (response bukan JSON)`);
      }
      const full = String(data.reply || '');
      if (full) onDelta(full, full, {});
      return { reply: full, conversationId: data.conversationId || null, title: data.title || null };
    }

    if (!res.ok) throw new Error(`HTTP ${res.status} (response bukan JSON)`);

    const reader = res.body && res.body.getReader && res.body.getReader();
    if (!reader) throw new Error('Browser tidak mendukung streaming.');

    const decoder = new TextDecoder();
    let buf = '';
    let reply = '';
    let convId = null;
    let title = null;
    let modelOut = null;
    let usage = null;
    let sawDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        let evt;
        try { evt = JSON.parse(json); } catch { continue; }
        if (typeof evt.error === 'string') throw new Error(evt.error);
        if (typeof evt.conversationId === 'string') convId = evt.conversationId;
        if (typeof evt.delta === 'string' && evt.delta) {
          reply += evt.delta;
          try { onDelta(evt.delta, reply, evt); } catch { /* ignore */ }
        }
        if (evt.done) {
          sawDone = true;
          if (typeof evt.model === 'string') modelOut = evt.model;
          if (typeof evt.title === 'string') title = evt.title;
          if (typeof evt.conversationId === 'string') convId = evt.conversationId;
          if (evt.usage) usage = evt.usage;
        }
      }
    }
    if (!sawDone && !reply) throw new Error('Stream berakhir tanpa response.');
    return { reply, conversationId: convId, title, model: modelOut, usage };
  }

  /* ============================================================
   * Send / regenerate
   * ============================================================ */
  async function sendMessage(text) {
    if (isSending) return;
    text = (text || '').trim();
    if (!text && pendingAttachments.length === 0) return;

    isSending = true;
    $send.disabled = true;
    $attachBtn.disabled = true;

    const sentAttachments = pendingAttachments.map(a => ({
      kind: a.kind, name: a.name, mime: a.mime, data: a.data, text: a.text,
    }));
    pendingAttachments = [];
    renderAttachmentsBar();

    // Push optimistic user message
    const userMsg = { role: 'user', content: text, attachments: sentAttachments };
    messages.push(userMsg);

    // Hapus empty state
    const empty = $chat.querySelector('.empty-state');
    if (empty) empty.remove();

    appendMessage('user', text, { attachments: sentAttachments });
    const $thinking = appendMessage('assistant', '');
    const indicator = attachTypingIndicator($thinking);

    let indicatorRemoved = false;
    const onDelta = (_chunk, full) => {
      if (!indicatorRemoved) { indicator.remove(); indicatorRemoved = true; }
      renderMsgContent($thinking, 'assistant', full);
      scrollToBottom();
    };

    try {
      const data = await streamChat({
        conversationId: currentConvId || undefined,
        message: { content: text, attachments: sentAttachments },
        model: $modelSel.value || undefined,
      }, onDelta);

      if (!indicatorRemoved) indicator.remove();
      const reply = data.reply || '(kosong)';
      renderMsgContent($thinking, 'assistant', reply);
      appendActions($thinking, 'assistant');
      messages.push({ role: 'assistant', content: reply });

      // Update conversation id (server may have created one).
      if (data.conversationId && data.conversationId !== currentConvId) {
        currentConvId = data.conversationId;
      }
      if (data.title) {
        // Update local list entry or insert.
        const existing = conversations.find(c => c.id === currentConvId);
        if (existing) {
          existing.title = data.title;
          existing.updatedAt = Date.now();
        } else if (currentConvId) {
          conversations.unshift({ id: currentConvId, title: data.title, updatedAt: Date.now() });
        }
        renderConversationList();
      } else {
        // Refresh list to capture server-side updatedAt changes.
        loadConversations();
      }
    } catch (e) {
      if (!indicatorRemoved) indicator.remove();
      $thinking.classList.add('error');
      renderMsgContent($thinking, 'assistant', '**Error:** ' + e.message);
    } finally {
      isSending = false;
      $send.disabled = false;
      $attachBtn.disabled = false;
      scrollToBottom();
    }
  }

  async function regenerateLast() {
    if (isSending) return;
    if (messages.length === 0) return;
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') { lastAssistantIdx = i; break; }
    }
    if (lastAssistantIdx === -1) return;
    let lastUserIdx = -1;
    for (let i = lastAssistantIdx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return;

    // Remove last assistant from local + DOM.
    messages.splice(lastAssistantIdx, 1);
    const $msgs = $chat.querySelectorAll('.msg.assistant');
    if ($msgs.length > 0) $msgs[$msgs.length - 1].remove();

    // Re-pop last user too — sendMessage will re-add it.
    const lastUser = messages.splice(lastUserIdx, 1)[0];
    const $userMsgs = $chat.querySelectorAll('.msg.user');
    if ($userMsgs.length > 0) $userMsgs[$userMsgs.length - 1].remove();

    pendingAttachments = (lastUser.attachments || []).map(a => Object.assign({}, a));
    renderAttachmentsBar();
    sendMessage(lastUser.content || '');
  }

  /* ============================================================
   * Attachments UI
   * ============================================================ */
  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = reject;
      r.readAsText(file);
    });
  }

  const MAX_PER_FILE = 5 * 1024 * 1024;
  const MAX_ATTACH = 6;
  const TEXTLIKE_EXT = /\.(txt|md|json|csv|log|html?|css|js|ts|py|php|java|c|cpp|h|hpp|go|rs|sh|ya?ml|xml|sql|toml|ini|conf|env|tsx|jsx)$/i;

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const f of files) {
      if (pendingAttachments.length >= MAX_ATTACH) {
        alert(`Maksimum ${MAX_ATTACH} attachment per pesan.`);
        break;
      }
      if (f.size > MAX_PER_FILE) {
        alert(`File terlalu besar (>5MB): ${f.name}`);
        continue;
      }
      try {
        if (f.type && f.type.startsWith('image/')) {
          const dataUrl = await readFileAsDataURL(f);
          // Strip prefix to get raw base64
          const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
          if (!m) { alert(`Gagal baca gambar: ${f.name}`); continue; }
          pendingAttachments.push({
            kind: 'image',
            name: f.name,
            mime: m[1],
            data: m[2],
            previewUrl: dataUrl,
          });
        } else if (f.type.startsWith('text/') || TEXTLIKE_EXT.test(f.name)) {
          const text = await readFileAsText(f);
          pendingAttachments.push({
            kind: 'file',
            name: f.name,
            mime: f.type || 'text/plain',
            text,
          });
        } else {
          // Other binary: read as base64 (model won't likely use it, but kept).
          const dataUrl = await readFileAsDataURL(f);
          const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
          if (!m) { alert(`Tidak bisa baca: ${f.name}`); continue; }
          pendingAttachments.push({
            kind: 'file',
            name: f.name,
            mime: m[1],
            data: m[2],
          });
        }
      } catch (e) {
        alert('Gagal baca file: ' + (e.message || String(e)));
      }
    }
    renderAttachmentsBar();
  }

  function renderAttachmentsBar() {
    if (pendingAttachments.length === 0) {
      $attachBar.hidden = true;
      $attachBar.innerHTML = '';
      return;
    }
    $attachBar.hidden = false;
    $attachBar.innerHTML = pendingAttachments.map((a, i) => {
      if (a.kind === 'image') {
        return `<div class="att-chip att-image" data-idx="${i}">
          <img src="${a.previewUrl || ''}" alt="${escapeHtml(a.name)}">
          <button type="button" class="att-x" data-act="rm-attach" data-idx="${i}" title="Hapus" aria-label="Hapus attachment">×</button>
        </div>`;
      }
      return `<div class="att-chip att-file" data-idx="${i}">
        <span class="att-icon">📄</span>
        <span class="att-name">${escapeHtml(a.name)}</span>
        <button type="button" class="att-x" data-act="rm-attach" data-idx="${i}" title="Hapus" aria-label="Hapus attachment">×</button>
      </div>`;
    }).join('');
  }

  /* ============================================================
   * Sidebar (mobile drawer)
   * ============================================================ */
  function openSidebarMobile() {
    $sidebar.classList.add('open');
    $sbBackdrop.hidden = false;
  }
  function closeSidebarMobile() {
    $sidebar.classList.remove('open');
    $sbBackdrop.hidden = true;
  }

  /* ============================================================
   * Composer behaviour
   * ============================================================ */
  function autoResize() {
    $input.style.height = 'auto';
    $input.style.height = Math.min($input.scrollHeight, 200) + 'px';
  }

  $input.addEventListener('input', autoResize);
  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $form.requestSubmit();
    }
  });

  $form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $input.value.trim();
    if (!text && pendingAttachments.length === 0) return;
    $input.value = '';
    autoResize();
    sendMessage(text);
  });

  // Drag & drop attachments
  ['dragenter', 'dragover'].forEach(t => {
    document.body.addEventListener(t, (e) => { e.preventDefault(); document.body.classList.add('dragover'); });
  });
  ['dragleave', 'dragend', 'drop'].forEach(t => {
    document.body.addEventListener(t, () => document.body.classList.remove('dragover'));
  });
  document.body.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  });

  // Paste images
  $input.addEventListener('paste', (e) => {
    if (!e.clipboardData) return;
    const files = [];
    for (const item of e.clipboardData.items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      handleFiles(files);
    }
  });

  $attachBtn.addEventListener('click', () => $fileInput.click());
  $fileInput.addEventListener('change', () => {
    handleFiles($fileInput.files);
    $fileInput.value = '';
  });

  $attachBar.addEventListener('click', (e) => {
    const $btn = e.target.closest('[data-act="rm-attach"]');
    if (!$btn) return;
    const i = +$btn.getAttribute('data-idx');
    pendingAttachments.splice(i, 1);
    renderAttachmentsBar();
  });

  $newChat.addEventListener('click', () => startNewChat());
  if ($newChatMob) $newChatMob.addEventListener('click', () => startNewChat());

  function startNewChat() {
    currentConvId = null;
    messages = [];
    pendingAttachments = [];
    renderAttachmentsBar();
    renderAll();
    renderConversationList();
    closeSidebarMobile();
    $input.focus();
  }

  $modelSel.addEventListener('change', () => {
    localStorage.setItem(MODEL_KEY, $modelSel.value);
  });

  $sbToggle.addEventListener('click', openSidebarMobile);
  $sbClose.addEventListener('click', closeSidebarMobile);
  $sbBackdrop.addEventListener('click', closeSidebarMobile);

  // Conversation list clicks (delegated)
  $convList.addEventListener('click', (e) => {
    const $btn = e.target.closest('[data-act]');
    if (!$btn) return;
    const id = $btn.getAttribute('data-id');
    const act = $btn.getAttribute('data-act');
    if (!id) return;
    if (act === 'open') loadConversation(id);
    else if (act === 'rename') {
      const c = conversations.find(c => c.id === id);
      renameConversation(id, c ? c.title : '');
    } else if (act === 'delete') {
      deleteConversation(id);
    }
  });

  // Message-level actions (copy / regen / copy-code)
  $chat.addEventListener('click', async (e) => {
    const $btn = e.target.closest('[data-act]');
    if (!$btn) return;
    const act = $btn.getAttribute('data-act');

    if (act === 'copy-code') {
      const $codeBlock = $btn.closest('.code-block');
      const code = $codeBlock?.querySelector('code')?.innerText || '';
      try {
        await navigator.clipboard.writeText(code);
        const $label = $btn.querySelector('span');
        const orig = $label ? $label.textContent : '';
        $btn.classList.add('copied');
        if ($label) $label.textContent = 'Copied';
        setTimeout(() => {
          $btn.classList.remove('copied');
          if ($label) $label.textContent = orig || 'Copy';
        }, 1200);
      } catch { /* ignore */ }
      return;
    }

    const $msg = $btn.closest('.msg.assistant');
    if (!$msg) return;
    if (act === 'copy') {
      const text = $msg.querySelector('.msg-content')?.innerText || '';
      try {
        await navigator.clipboard.writeText(text);
        const orig = $btn.innerHTML;
        $btn.classList.add('copied');
        $btn.innerHTML = $btn.innerHTML.replace(/Copy/, 'Copied');
        setTimeout(() => {
          $btn.classList.remove('copied');
          $btn.innerHTML = orig;
        }, 1200);
      } catch { /* ignore */ }
    } else if (act === 'regen') {
      regenerateLast();
    }
  });

  /* ============================================================
   * Init
   * ============================================================ */
  renderAll();
  renderConversationList();
  loadModels();
  loadConversations();
  autoResize();
  $input.focus();

  // Re-decorate code blocks once hljs finishes loading async
  window.addEventListener('load', () => {
    document.querySelectorAll('.msg-content').forEach(decorateCodeBlocks);
  });
})();
