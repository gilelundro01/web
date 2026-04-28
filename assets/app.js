(() => {
  'use strict';

  /* ============================================================
   * Element refs
   * ============================================================ */
  const $chat     = document.getElementById('chat');
  const $form     = document.getElementById('composer');
  const $input    = document.getElementById('input');
  const $send     = document.getElementById('send-btn');
  const $clear    = document.getElementById('clear-btn');
  const $modelSel = document.getElementById('model');

  const STORAGE_KEY = 'claude-chat-history-v2';
  const MODEL_KEY   = 'claude-chat-model-v1';

  /** @type {{role:'user'|'assistant', content:string}[]} */
  let history = loadHistory();
  let isSending = false;

  /* ============================================================
   * History persistence
   * ============================================================ */
  function loadHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  function saveHistory() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(history)); } catch { /* quota */ }
  }

  /* ============================================================
   * Tiny markdown renderer (subset)
   * Supports: code blocks ```lang\n...```, inline `code`,
   * **bold**, *italic*, # heading, - list, > blockquote,
   * [text](url), and paragraphs.
   * ============================================================ */
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    })[c]);
  }

  function renderInline(text) {
    let out = escapeHtml(text);

    // inline code (handle first to protect content)
    const codeStubs = [];
    out = out.replace(/`([^`\n]+)`/g, (_, c) => {
      codeStubs.push(c);
      return `\u0000CODE${codeStubs.length - 1}\u0000`;
    });

    // bold **x** then italic *x*
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

    // links [text](url) — only http(s)
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // restore inline code
    out = out.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => `<code>${codeStubs[+i]}</code>`);
    return out;
  }

  function renderMarkdown(text) {
    if (!text) return '';

    // Extract code blocks first.
    const blocks = [];
    text = text.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_, lang, body) => {
      blocks.push({ lang, body });
      return `\u0000BLOCK${blocks.length - 1}\u0000`;
    });

    // Split by blank lines into "paragraphs", but keep block markers/lists intact.
    const lines = text.split('\n');
    const html = [];
    let buf = [];
    let mode = null; // null | 'ul' | 'ol' | 'bq'

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

      // Code block placeholder.
      const blockMatch = line.match(/^\u0000BLOCK(\d+)\u0000$/);
      if (blockMatch) {
        flushBuf(); flushList();
        const { lang, body } = blocks[+blockMatch[1]];
        html.push(`<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${escapeHtml(body.replace(/\n$/, ''))}</code></pre>`);
        continue;
      }

      if (line === '') {
        flushBuf(); flushList();
        continue;
      }

      // Headings.
      const h = line.match(/^(#{1,3})\s+(.+)$/);
      if (h) {
        flushBuf(); flushList();
        html.push(`<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`);
        continue;
      }

      // Unordered list.
      const ul = line.match(/^\s*[-*]\s+(.+)$/);
      if (ul) {
        flushBuf();
        if (mode !== 'ul') { flushList(); html.push('<ul>'); mode = 'ul'; }
        html.push(`<li>${renderInline(ul[1])}</li>`);
        continue;
      }

      // Ordered list.
      const ol = line.match(/^\s*\d+\.\s+(.+)$/);
      if (ol) {
        flushBuf();
        if (mode !== 'ol') { flushList(); html.push('<ol>'); mode = 'ol'; }
        html.push(`<li>${renderInline(ol[1])}</li>`);
        continue;
      }

      // Blockquote.
      const bq = line.match(/^>\s?(.*)$/);
      if (bq) {
        flushBuf();
        if (mode !== 'bq') { flushList(); html.push('<blockquote>'); mode = 'bq'; }
        html.push(`<p>${renderInline(bq[1])}</p>`);
        continue;
      }

      // Plain line — accumulate into paragraph.
      if (mode) flushList();
      buf.push(line);
    }
    flushBuf(); flushList();
    return html.join('\n');
  }

  /* ============================================================
   * UI: empty state & suggestions
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
        if (!s) return;
        sendMessage(s.sub);
      });
    });
  }

  /* ============================================================
   * UI: messages
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

  function renderMsgContent($msg, role, content) {
    const $c = $msg.querySelector('.msg-content');
    if (role === 'assistant') {
      $c.innerHTML = renderMarkdown(content);
    } else {
      // User messages: preserve newlines, escape, no markdown.
      $c.innerHTML = escapeHtml(content).replace(/\n/g, '<br>');
    }
  }

  function appendMessage(role, content, opts = {}) {
    const $msg = makeMsgEl(role, opts);
    if (content) renderMsgContent($msg, role, content);
    $chat.appendChild($msg);
    scrollToBottom();
    return $msg;
  }

  function appendActions($msg, role) {
    if (role !== 'assistant') return;
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
    if (history.length === 0) {
      renderEmpty();
      return;
    }
    for (const m of history) {
      const $msg = appendMessage(m.role, m.content);
      if (m.role === 'assistant') appendActions($msg, m.role);
    }
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    });
  }

  /* ============================================================
   * Status pill (Devin-style "working" / "deciding action")
   * ============================================================ */
  const PHASES = [
    'Thinking',
    'Deciding next action',
    'Working',
    'Generating response',
  ];

  function attachStatusPill($msg) {
    const $c = $msg.querySelector('.msg-content');
    const $pill = document.createElement('div');
    $pill.className = 'status-pill';
    $pill.innerHTML = PHASES
      .map((p, i) => `
        <div class="status-step${i === 0 ? ' active' : ''}" data-step="${i}">
          <span class="dot"></span>
          <span>${escapeHtml(p)}</span>
        </div>`)
      .join('');
    $c.appendChild($pill);

    let current = 0;
    const timer = setInterval(() => {
      if (current >= PHASES.length - 1) return; // pegang phase terakhir sampai response masuk
      const $steps = $pill.querySelectorAll('.status-step');
      $steps[current].classList.remove('active');
      $steps[current].classList.add('done');
      current += 1;
      $steps[current].classList.add('active');
      scrollToBottom();
    }, 1200);

    return {
      stop: () => clearInterval(timer),
      remove: () => { clearInterval(timer); $pill.remove(); },
    };
  }

  /* ============================================================
   * Networking
   * ============================================================ */
  async function loadModels() {
    try {
      const res = await fetch('api/models.php', { cache: 'no-store' });
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

  async function callApi(messages, model) {
    // Use form-encoded with a `data=<json>` field. Many shared hosts
    // (notably InfinityFree) have mod_security rules that 403 a POST
    // whose Content-Type is application/json before it reaches PHP;
    // form-encoded requests slip through. Backend accepts both.
    const payload = JSON.stringify({ model, messages });
    const res = await fetch('api/chat.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(payload),
    });
    const data = await res.json().catch(() => ({
      ok: false, error: `HTTP ${res.status} (response bukan JSON)`,
    }));
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  /* ============================================================
   * Send / regenerate flow
   * ============================================================ */
  async function sendMessage(text) {
    if (isSending) return;
    isSending = true;
    $send.disabled = true;

    history.push({ role: 'user', content: text });
    saveHistory();

    // Hapus empty state kalau masih ada.
    const empty = $chat.querySelector('.empty-state');
    if (empty) empty.remove();

    appendMessage('user', text);
    const $thinking = appendMessage('assistant', '');
    const pill = attachStatusPill($thinking);

    try {
      const data = await callApi(history, $modelSel.value || undefined);
      pill.remove();
      const reply = data.reply || '(kosong)';
      renderMsgContent($thinking, 'assistant', reply);
      appendActions($thinking, 'assistant');
      history.push({ role: 'assistant', content: reply });
      saveHistory();
    } catch (e) {
      pill.remove();
      $thinking.classList.add('error');
      renderMsgContent($thinking, 'assistant', '**Error:** ' + e.message);
    } finally {
      isSending = false;
      $send.disabled = false;
      scrollToBottom();
    }
  }

  async function regenerateLast() {
    if (isSending) return;
    if (history.length === 0) return;

    // Hapus pesan assistant terakhir dari history & DOM.
    let lastAssistantIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'assistant') { lastAssistantIdx = i; break; }
    }
    if (lastAssistantIdx === -1) return;
    history.splice(lastAssistantIdx, 1);
    saveHistory();

    // Hapus elemen assistant terakhir.
    const $msgs = $chat.querySelectorAll('.msg.assistant');
    if ($msgs.length === 0) return;
    $msgs[$msgs.length - 1].remove();

    isSending = true;
    $send.disabled = true;
    const $thinking = appendMessage('assistant', '');
    const pill = attachStatusPill($thinking);
    try {
      const data = await callApi(history, $modelSel.value || undefined);
      pill.remove();
      const reply = data.reply || '(kosong)';
      renderMsgContent($thinking, 'assistant', reply);
      appendActions($thinking, 'assistant');
      history.push({ role: 'assistant', content: reply });
      saveHistory();
    } catch (e) {
      pill.remove();
      $thinking.classList.add('error');
      renderMsgContent($thinking, 'assistant', '**Error:** ' + e.message);
    } finally {
      isSending = false;
      $send.disabled = false;
      scrollToBottom();
    }
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
    if (!text) return;
    $input.value = '';
    autoResize();
    sendMessage(text);
  });

  $clear.addEventListener('click', () => {
    if (history.length > 0 && !confirm('Mulai chat baru? Riwayat akan dihapus.')) return;
    history = [];
    saveHistory();
    renderAll();
  });

  $modelSel.addEventListener('change', () => {
    localStorage.setItem(MODEL_KEY, $modelSel.value);
  });

  // Delegated handlers untuk copy / regenerate.
  $chat.addEventListener('click', async (e) => {
    const $btn = e.target.closest('.msg-action-btn');
    if (!$btn) return;
    const act = $btn.getAttribute('data-act');
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
  loadModels();
  autoResize();
  $input.focus();
})();
