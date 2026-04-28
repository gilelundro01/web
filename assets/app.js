(() => {
  'use strict';

  const $chat     = document.getElementById('chat');
  const $form     = document.getElementById('composer');
  const $input    = document.getElementById('input');
  const $send     = document.getElementById('send-btn');
  const $clear    = document.getElementById('clear-btn');
  const $modelSel = document.getElementById('model');
  const $status   = document.getElementById('status');

  const STORAGE_KEY = 'claude-chat-history-v1';
  const MODEL_KEY   = 'claude-chat-model-v1';

  /** @type {{role:'user'|'assistant', content:string}[]} */
  let history = loadHistory();
  let isSending = false;

  /* ---------- History persistence ---------- */
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

  /* ---------- Render ---------- */
  function renderEmpty() {
    $chat.innerHTML = `
      <div class="empty-state">
        <h2>Mulai chat baru</h2>
        <p>Ketik pertanyaan apa pun. Riwayat percakapan disimpan di browser kamu.</p>
      </div>`;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[c]);
  }

  /** Sangat sederhana: render code blocks ```...``` dan inline `code`. */
  function renderContent(text) {
    const parts = [];
    let i = 0;
    const re = /```([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > i) parts.push({ type: 'text', value: text.slice(i, m.index) });
      parts.push({ type: 'code', value: m[1] });
      i = m.index + m[0].length;
    }
    if (i < text.length) parts.push({ type: 'text', value: text.slice(i) });

    return parts.map(p => {
      if (p.type === 'code') {
        return `<pre><code>${escapeHtml(p.value)}</code></pre>`;
      }
      const inlineCoded = escapeHtml(p.value).replace(/`([^`\n]+)`/g, '<code>$1</code>');
      return inlineCoded;
    }).join('');
  }

  function appendMessage(role, content, opts = {}) {
    const $msg = document.createElement('div');
    $msg.className = `msg ${role}` + (opts.error ? ' error' : '');
    const initial = role === 'user' ? 'U' : 'C';
    $msg.innerHTML = `
      <div class="avatar">${initial}</div>
      <div class="bubble">${opts.html ?? renderContent(content)}</div>
    `;
    $chat.appendChild($msg);
    scrollToBottom();
    return $msg;
  }

  function renderAll() {
    $chat.innerHTML = '';
    if (history.length === 0) {
      renderEmpty();
      return;
    }
    for (const m of history) appendMessage(m.role, m.content);
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    });
  }

  /* ---------- Networking ---------- */
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
      setStatus('Tidak bisa memuat daftar model: ' + e.message);
    }
  }

  async function sendMessage(text) {
    if (isSending) return;
    isSending = true;
    $send.disabled = true;

    history.push({ role: 'user', content: text });
    saveHistory();
    appendMessage('user', text);

    // Hilangkan empty state.
    if ($chat.querySelector('.empty-state')) {
      $chat.querySelector('.empty-state').remove();
    }

    const $thinking = appendMessage('assistant', '', {
      html: '<span class="typing"><span></span><span></span><span></span></span>',
    });
    setStatus('Menghubungi Claude…');

    try {
      const res = await fetch('api/chat.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: $modelSel.value || undefined,
          messages: history,
        }),
      });

      const data = await res.json().catch(() => ({
        ok: false, error: `HTTP ${res.status} (response bukan JSON)`,
      }));

      if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);

      const reply = data.reply || '(kosong)';
      $thinking.querySelector('.bubble').innerHTML = renderContent(reply);
      history.push({ role: 'assistant', content: reply });
      saveHistory();
      setStatus(data.model ? `Model: ${data.model}` : '');
    } catch (e) {
      $thinking.classList.add('error');
      $thinking.querySelector('.bubble').textContent = 'Error: ' + e.message;
      // Rollback: jangan simpan giliran assistant yang gagal.
      setStatus('Gagal mengirim. Coba lagi.');
    } finally {
      isSending = false;
      $send.disabled = false;
      scrollToBottom();
    }
  }

  function setStatus(text) {
    $status.textContent = text || '';
  }

  /* ---------- Composer behaviour ---------- */
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
    setStatus('');
  });

  $modelSel.addEventListener('change', () => {
    localStorage.setItem(MODEL_KEY, $modelSel.value);
  });

  /* ---------- Init ---------- */
  renderAll();
  loadModels();
  autoResize();
  $input.focus();
})();
