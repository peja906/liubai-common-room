/** Local-only workshop UI. It never reads the lounge or Wiki's private content. */
const DRAFT_KEY = 'liubai.workshop.draft.v1';
const LOUNGE_KEY = 'lounge.prototype.v1';
const HASH = /^[a-f0-9]{64}$/;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const empty = () => ({ version: 1, draft: { kind: 'discussion', nickname: '', body: '', replyTo: null }, outbox: [] });
const canonical = (draft) => ({ kind: draft.kind, nickname: draft.nickname.normalize('NFKC').trim() || '訪客', body: draft.body.trim(), replyTo: draft.replyTo || null });
const equalPayload = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const chars = (value) => Array.from(value).length;
const validDraft = (draft) => draft && ['discussion', 'proposal'].includes(draft.kind) && typeof draft.nickname === 'string' && chars(draft.nickname) <= 96 && typeof draft.body === 'string' && chars(draft.body) <= 6000 && (draft.replyTo === null || HASH.test(draft.replyTo));
const validState = (value) => value && value.version === 1 && validDraft(value.draft) && Array.isArray(value.outbox) && value.outbox.every((item) => item && HASH.test(item.submissionId) && validDraft(item.payload) && ['unknown', 'confirmed', 'rejected', 'not-sent'].includes(item.status) && Number.isFinite(item.createdAt));
const asTime = (value) => Number.isFinite(value) ? new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(value) : '時間未確認';
const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), (byte) => byte.toString(16).padStart(2, '0')).join('');
const validPost = (post) => post && HASH.test(post.id) && Number.isSafeInteger(post.seq) && post.seq > 0 && ['discussion', 'proposal'].includes(post.kind) && typeof post.nickname === 'string' && chars(post.nickname) <= 24 && typeof post.body === 'string' && chars(post.body) <= 1500 && (post.replyTo === null || HASH.test(post.replyTo)) && Number.isFinite(post.createdAt) && post.identity === 'unverified-visitor' && post.verification === 'unverified' && post.publication === 'public-proposal';

export function initWorkshopUI() {
  if (document.querySelector('#workshop-view')) return null;
  const nav = document.querySelector('.view-tabs');
  const main = document.querySelector('main.main');
  if (!nav || !main) throw new Error('Workshop requires the existing lounge shell');
  const tab = document.createElement('button'); tab.id = 'tab-workshop'; tab.type = 'button';
  tab.innerHTML = '共同工坊 <span>本機安全測試</span>'; nav.insertBefore(tab, document.querySelector('#open-data-info'));
  const root = document.createElement('section'); root.id = 'workshop-view'; root.className = 'workshop-view'; root.hidden = true; root.setAttribute('aria-label', '共同工坊本機安全測試'); main.append(root);
  root.innerHTML = `<div class="workshop-wrap"><header class="workshop-heading"><span class="workshop-eyebrow">共同工坊 · 本機安全測試 · 尚未上線</span><h2>把願意公開的話，留在同一張桌上。</h2><p>這裡與私人聊天、Wiki 本機草稿分開。你不必搬前情，也不會自動帶入任何私稿。</p></header><div class="workshop-boundary"><strong>公開內容，上線後全網可見。</strong><p>請勿貼私人、機密或他人的個人資料。目前只寫入本機測試資料庫，尚未開放正式站提交。真模型仍未連接，不能自動互通。</p></div><p id="workshop-storage-error" class="workshop-error" role="alert" hidden></p><div class="workshop-columns"><section class="workshop-compose" aria-labelledby="workshop-compose-title"><h3 id="workshop-compose-title">另外寫一段，確認後才公開</h3><p class="workshop-small">預設仍是本機草稿。沒有背景、分類或官方身分必填。</p><form id="workshop-form"><div class="workshop-fields"><div><label for="workshop-nickname">暱稱（可空白）</label><input id="workshop-nickname" maxlength="96" autocomplete="off" placeholder="訪客 · 未驗證名稱"></div><div><label for="workshop-kind">想留下</label><select id="workshop-kind"><option value="discussion">一段討論</option><option value="proposal">一個提案</option></select></div></div><p class="workshop-small">暱稱只是自填顯示名稱，不代表本人、模型或官方；請勿冒名。所有投稿均未審閱、未核實。</p><div id="workshop-reply" class="workshop-reply" hidden></div><label for="workshop-body">願意公開的內容</label><textarea id="workshop-body" rows="8" maxlength="6000" placeholder="這裡是獨立輸入框，不會讀入你的私人聊天或草稿。"></textarea><div class="workshop-draft-meta"><span id="workshop-draft-state" role="status"></span><span id="workshop-count">0／1500 字</span></div><label class="workshop-consent" for="workshop-consent"><input id="workshop-consent" type="checkbox"><span>我同意將這一段作為公開內容送出，並確認沒有私人或機密資料。</span></label><button id="workshop-send" class="primary-small" type="submit">公開送出（本機安全測試）</button></form><p id="workshop-submit-status" class="workshop-submit-status" role="status" aria-live="polite"></p><div id="workshop-outbox"></div><div class="workshop-local-actions"><button id="workshop-export" type="button" class="text-button">匯出工坊本機草稿與收件紀錄</button><button id="workshop-clear" type="button" class="text-button">清除工坊本機資料</button></div></section><section class="workshop-feed" aria-labelledby="workshop-feed-title"><div class="workshop-feed-heading"><div><h3 id="workshop-feed-title">同一份討論與提案</h3><p class="workshop-small">本機共同資料庫 · 訪客投稿 · 未審閱</p></div><button id="workshop-refresh" class="quiet-button" type="button">重新讀取</button></div><p id="workshop-feed-status" class="workshop-small" role="status"></p><div id="workshop-posts"></div><button id="workshop-older" class="quiet-button" type="button" hidden>讀取較早的 20 則</button><p class="workshop-footnote">公眾只能新增提案，不能覆寫公共 Wiki 或刪改他人內容。完全相同的內容會合併成同一則；暱稱不能當作身分證明。沒有自動輪詢。</p></section></div></div>`;
  const clearDialog = document.createElement('dialog'); clearDialog.id = 'workshop-clear-dialog'; clearDialog.setAttribute('aria-labelledby', 'workshop-clear-title');
  clearDialog.innerHTML = `<h2 id="workshop-clear-title">清除工坊本機資料？</h2><p>會清除此瀏覽器的工坊草稿、回覆選擇與全部送出結果紀錄，包含仍未知的結果。共同資料庫內已公開內容不會刪除，也不會影響私人聊天及 Wiki 草稿。可先匯出；確認後不能在此復原。</p><button type="button" class="text-button" id="workshop-export-before-clear">先匯出工坊本機備份</button><div class="dialog-actions"><button type="button" class="quiet-button" id="workshop-cancel-clear">保留資料</button><button type="button" class="danger-button" id="workshop-confirm-clear">確認清除工坊本機資料</button></div>`;
  document.body.append(clearDialog);
  document.querySelector('.clear-scope')?.insertAdjacentHTML('beforeend', '<li data-workshop-clear-scope>工坊本機草稿與送出結果紀錄（不刪共同資料庫；工坊備份請另按下方匯出）</li>');
  const globalExport = document.createElement('button'); globalExport.type = 'button'; globalExport.id = 'workshop-export-in-global-clear'; globalExport.className = 'backup-before-clear'; globalExport.textContent = '另匯出工坊本機備份 ↗'; document.querySelector('#clear-data-dialog .dialog-actions')?.before(globalExport);
  const $ = (selector) => root.querySelector(selector);
  let state = empty(), rawRecord = null, storageError = '', storageConflict = false, busy = false, generation = 0;
  let posts = [], nextCursor = null, feedLoaded = false, feedBusy = false, writes = 'unknown';
  const controllers = new Set();
  try { rawRecord = localStorage.getItem(DRAFT_KEY); if (rawRecord !== null) { const parsed = JSON.parse(rawRecord); if (!validState(parsed)) throw new Error('invalid'); state = parsed; } }
  catch { storageError = '工坊本機紀錄無法讀取，原資料保留；目前禁止送出，請先匯出或自行確認清除。'; }

  function save() {
    if (storageError || storageConflict) { renderStorage(); return false; }
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(state)); return true; }
    catch { storageError = '工坊本機保存未成功。請保持此頁開啟並匯出；是否已公開，以收件狀態為準。'; renderStorage(); return false; }
  }
  function pending() { return state.outbox.find((item) => item.status === 'unknown'); }
  function renderStorage() {
    const error = storageError || (storageConflict ? '另一分頁改動工坊紀錄，已停止覆寫。請匯出此頁，再重新整理。' : '');
    $('#workshop-storage-error').hidden = !error; $('#workshop-storage-error').textContent = error;
    $('#workshop-draft-state').textContent = error ? '此頁內容尚未保存' : '草稿僅本機，尚未公開';
    $('#workshop-send').disabled = Boolean(error || busy || pending() || writes !== 'enabled');
  }
  function renderDraft() {
    $('#workshop-nickname').value = state.draft.nickname; $('#workshop-kind').value = state.draft.kind; $('#workshop-body').value = state.draft.body;
    $('#workshop-count').textContent = `${chars(state.draft.body)}／1500 字`;
    const reply = posts.find((post) => post.id === state.draft.replyTo);
    $('#workshop-reply').hidden = !state.draft.replyTo;
    $('#workshop-reply').innerHTML = state.draft.replyTo ? `<span>回覆共同資料庫的公開一則：${reply ? escape(reply.body.slice(0, 90)) : escape(state.draft.replyTo.slice(0, 12))}</span><button type="button" data-workshop-action="cancel-reply" aria-label="取消公開回覆來源">×</button>` : '';
    renderStorage();
  }
  function renderOutbox() {
    const unresolved = pending();
    const history = state.outbox.filter((item) => item !== unresolved);
    $('#workshop-outbox').innerHTML = `${unresolved ? `<section class="workshop-unknown" data-submission-id="${escape(unresolved.submissionId)}"><strong>這次公開送出結果未知</strong><p>不把未知當作成功，也不會自動重送。新草稿可以繼續寫；請先查這筆收件結果，再處理同一筆送出。</p><blockquote>${escape(unresolved.payload.body)}</blockquote><small>${asTime(unresolved.createdAt)} · 內容與識別碼已留在本機</small><p>${escape(unresolved.note || '')}</p><div class="workshop-receipt-actions"><button type="button" class="quiet-button" data-workshop-action="check" data-id="${escape(unresolved.submissionId)}" ${busy ? 'disabled' : ''}>查詢這次送出結果</button><button type="button" class="text-button" data-workshop-action="resend" data-id="${escape(unresolved.submissionId)}" ${busy ? 'disabled' : ''}>再送同一筆公開內容</button></div></section>` : ''}${history.length ? `<details class="workshop-receipt-history"><summary>本機送出結果紀錄（${history.length}）</summary>${[...history].reverse().map((item) => `<article><strong>${item.status === 'confirmed' ? '相同公開內容已從共同資料庫確認' : item.status === 'not-sent' ? '未發出請求' : item.status === 'unknown' ? '送出結果仍未知' : '伺服器未接受這次送出'}</strong><p>${escape(item.payload.body)}</p><small>${asTime(item.createdAt)} · ${escape(item.note || '')}</small></article>`).join('')}</details>` : ''}`;
    renderStorage();
  }
  function renderPosts() {
    $('#workshop-posts').innerHTML = posts.length ? posts.map((post) => `<article class="workshop-post" data-public-post-id="${escape(post.id)}"><header><strong>訪客自填・未驗證：${escape(post.nickname)}</strong><span>${post.kind === 'proposal' ? '提案' : '討論'}</span></header>${post.replyTo ? `<p class="workshop-public-reply">回覆公開內容 ${escape(post.replyTo.slice(0, 12))}…</p>` : ''}<p class="workshop-post-body">${escape(post.body)}</p><footer><span>${asTime(post.createdAt)} · 未審閱／未核實</span><button type="button" class="text-button" data-workshop-action="reply" data-id="${escape(post.id)}">回覆這一則公開內容</button></footer></article>`).join('') : '<p class="workshop-empty">這份共同資料庫還沒有內容。<br>只留下你明確願意公開的一段。</p>';
    $('#workshop-older').hidden = nextCursor === null;
  }
  function status(text) { $('#workshop-submit-status').textContent = text; }
  async function request(path, options = {}) {
    const controller = new AbortController(); controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(path, { ...options, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', signal: controller.signal });
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('invalid-response');
      const reader = response.body.getReader(); let size = 0; const chunks = [];
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 262144) { await reader.cancel(); throw new Error('oversized-response'); } chunks.push(part.value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
      return { status: response.status, data: JSON.parse(new TextDecoder().decode(bytes)) };
    } finally { clearTimeout(timeout); controllers.delete(controller); }
  }
  async function loadFeed(older = false) {
    if (feedBusy) return; feedBusy = true; const current = generation;
    $('#workshop-refresh').disabled = true; $('#workshop-older').disabled = true; $('#workshop-feed-status').textContent = '正在讀取同一份本機共同資料庫…';
    try {
      const suffix = older && Number.isSafeInteger(nextCursor) ? `?cursor=${nextCursor}` : '';
      const { status: code, data } = await request('/api/workshop/posts' + suffix);
      if (current !== generation) return;
      if (code !== 200 || data.schema !== 'liubai-workshop' || data.schemaVersion !== 1 || !Array.isArray(data.posts) || data.posts.length > 20 || !data.posts.every(validPost) || !['enabled', 'disabled'].includes(data.writes) || !(data.nextCursor === null || Number.isSafeInteger(data.nextCursor) && data.nextCursor > 0)) throw new Error('invalid-feed');
      posts = older ? [...new Map([...posts, ...data.posts].map((post) => [post.id, post])).values()] : data.posts;
      nextCursor = data.nextCursor; writes = data.writes; feedLoaded = true;
      $('#workshop-feed-status').textContent = writes === 'enabled' ? '已讀取本機共同資料庫；本機測試提交開啟，正式站未上線。' : '已讀取共同內容；伺服器已關閉提交，無法公開送出。';
      renderPosts(); renderDraft();
    } catch { if (current === generation) { writes = 'unknown'; posts = []; nextCursor = null; renderPosts(); renderDraft(); $('#workshop-feed-status').textContent = '共同資料庫目前無法確認，已收起這次讀取的公共內容；本機草稿與收件紀錄保留，沒有宣告共享成功。請手動重讀。'; } }
    finally { feedBusy = false; $('#workshop-refresh').disabled = false; $('#workshop-older').disabled = false; renderStorage(); }
  }
  function exactReceipt(item, data) {
    return data.status === 'confirmed' && validPost(data.post) && data.post.id === item.submissionId && equalPayload(data.post, item.payload);
  }
  function accept(item, data, current) {
    if (current !== generation) return;
    item.status = 'confirmed'; item.note = '資料庫收件已核對；不是模型或官方身分確認。'; item.confirmedAt = Date.now();
    if (equalPayload(state.draft, item.payload)) state.draft = { ...empty().draft, nickname: state.draft.nickname };
    const stored = save(); $('#workshop-consent').checked = false; renderDraft(); renderOutbox();
    status(stored ? (data.duplicate === true ? '相同公開內容已收錄，沒有新增重複。這不證明投稿身分或模型收件。' : '已確認這一則公開內容存在共同資料庫。這不證明投稿身分或模型收件。私人聊天及 Wiki 沒有上傳。') : '共同資料庫已確認，但本機收件狀態未保存；請匯出並保持此頁。');
    loadFeed();
  }
  async function sendItem(item) {
    if (busy || storageError || storageConflict) return;
    busy = true; const current = generation; renderOutbox(); status('正在送出你明確同意公開的這一筆…');
    try {
      const { status: code, data } = await request('/api/workshop/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...item.payload, submissionId: item.submissionId }) });
      if (current !== generation) return;
      if ((code === 200 || code === 201) && exactReceipt(item, data)) { accept(item, data, current); return; }
      if ([400, 403, 409, 413, 415, 422, 429, 507].includes(code) || (code === 408 && data.error === 'request_read_timeout')) {
        item.status = 'rejected'; item.note = code === 429 ? '提交頻率上限，伺服器未接受。可修改或稍後自行送出，沒有自動重試。' : code === 507 ? '共同資料容量已達上限，伺服器未接受。' : '伺服器未接受。請檢查字數、暱稱及公開內容；原稿仍在本機。'; save(); renderOutbox(); status(item.note);
      } else { item.note = '沒有取得可核對的資料庫收件結果。'; save(); renderOutbox(); status('送出結果未知，請手動查詢；不會自動重送。'); }
    } catch { if (current === generation) { item.note = '連線或回應中斷，不能確認是否已寫入。'; save(); renderOutbox(); status('送出結果未知，內容與識別碼留在本機；不會自動重送。'); } }
    finally { busy = false; renderOutbox(); }
  }
  async function checkItem(item) {
    if (busy) return; busy = true; const current = generation; renderOutbox(); status('只查詢公開收件結果，不重送內容…');
    try {
      const { status: code, data } = await request('/api/workshop/receipt/' + item.submissionId);
      if (current !== generation) return;
      if (code === 200 && exactReceipt(item, data)) { accept(item, data, current); return; }
      item.note = code === 404 && data.status === 'not_found' ? '目前查無此筆，仍保留未知；這不等於證明它從未送達。可稍後再查，或明確重送同一筆。' : '目前沒有可核對的收件結果，仍保留未知。'; save(); renderOutbox(); status(item.note);
    } catch { if (current === generation) status('查詢未成功，原結果仍未知；沒有重送。'); }
    finally { busy = false; renderOutbox(); }
  }
  function exportLocal() {
    const payload = { schema: 'liubai-workshop-local-backup', version: 1, exportedAt: new Date().toISOString(), state, unreadableOriginalRecord: storageError && rawRecord !== null ? rawRecord : undefined };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `留白工坊-本機備份-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); status('已建立本機備份下載，沒有上傳。');
  }
  function resetLocal(remove = true) {
    if (remove) localStorage.removeItem(DRAFT_KEY);
    generation += 1; for (const controller of controllers) controller.abort(); controllers.clear();
    state = empty(); rawRecord = null; storageError = ''; storageConflict = false; busy = false;
    $('#workshop-consent').checked = false; renderDraft(); renderOutbox(); status('工坊本機資料已由使用者清除；共同資料庫內容不受影響。');
  }
  function hideWorkshop() { root.hidden = true; tab.removeAttribute('aria-current'); }
  tab.addEventListener('click', () => {
    document.querySelector('#close-notebook')?.click(); document.querySelector('#chat-view').hidden = true; document.querySelector('#wiki-view').hidden = true;
    root.hidden = false; document.querySelector('#tab-chat')?.removeAttribute('aria-current'); document.querySelector('#tab-wiki')?.removeAttribute('aria-current'); tab.setAttribute('aria-current', 'page');
    if (!feedLoaded && !feedBusy) loadFeed();
  });
  for (const id of ['#tab-chat', '#tab-wiki', '#notebook-wiki']) document.querySelector(id)?.addEventListener('click', hideWorkshop);
  window.addEventListener('hashchange', hideWorkshop);
  root.addEventListener('input', (event) => {
    if (!['workshop-nickname', 'workshop-kind', 'workshop-body'].includes(event.target.id)) return;
    state.draft.nickname = $('#workshop-nickname').value; state.draft.kind = $('#workshop-kind').value; state.draft.body = $('#workshop-body').value;
    $('#workshop-consent').checked = false; $('#workshop-count').textContent = `${chars(state.draft.body)}／1500 字`; save(); renderStorage();
  });
  $('#workshop-form').addEventListener('keydown', (event) => { if (event.key === 'Enter' && ['workshop-nickname', 'workshop-kind'].includes(event.target.id)) event.preventDefault(); });
  $('#workshop-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy || pending() || storageError || storageConflict || writes !== 'enabled') return;
    if (!$('#workshop-consent').checked) { status('請先確認願意公開這一段，並且沒有私人或機密內容。'); $('#workshop-consent').focus(); return; }
    const payload = canonical(state.draft);
    if (!payload.body || chars(payload.body) > 1500 || chars(payload.nickname) > 24) { status('內容需為 1–1500 字，暱稱最多 24 字；請修正後再勾選公開同意。'); return; }
    busy = true; renderStorage();
    const current = generation;
    try {
      const submissionId = await digest(payload); if (current !== generation) return;
      const known = state.outbox.find((item) => item.submissionId === submissionId && item.status === 'confirmed');
      if (known) { status('相同內容已核對存在共同資料庫，沒有再次送出。'); return; }
      const item = { submissionId, payload, status: 'unknown', createdAt: Date.now(), note: '已記下這筆內容與識別碼，等待資料庫回應。' }; state.outbox.push(item);
      if (!save()) { item.status = 'not-sent'; item.note = '本機未能先保存收件識別，未發出網路請求；原稿、內容與識別碼仍在此頁，可匯出。'; status(item.note); return; }
      busy = false; await sendItem(item);
    } catch { status('未能準備送出識別碼，沒有送出內容。'); }
    finally { busy = false; renderOutbox(); }
  });
  root.addEventListener('click', (event) => {
    const target = event.target.closest('[data-workshop-action]'); if (!target) return;
    const action = target.dataset.workshopAction;
    if (action === 'reply') { const post = posts.find((item) => item.id === target.dataset.id); if (!post) return; state.draft.replyTo = post.id; $('#workshop-consent').checked = false; save(); renderDraft(); $('#workshop-body').focus(); }
    if (action === 'cancel-reply') { state.draft.replyTo = null; $('#workshop-consent').checked = false; save(); renderDraft(); }
    if (action === 'check' || action === 'resend') { const item = state.outbox.find((entry) => entry.submissionId === target.dataset.id && entry.status === 'unknown'); if (!item) return; if (action === 'check') checkItem(item); else sendItem(item); }
  });
  $('#workshop-refresh').addEventListener('click', () => loadFeed()); $('#workshop-older').addEventListener('click', () => loadFeed(true));
  clearDialog.querySelector('#workshop-export-before-clear').addEventListener('click', exportLocal);
  globalExport.addEventListener('click', exportLocal);
  $('#workshop-export').addEventListener('click', exportLocal); $('#workshop-clear').addEventListener('click', () => clearDialog.showModal());
  clearDialog.querySelector('#workshop-cancel-clear').addEventListener('click', () => clearDialog.close());
  clearDialog.querySelector('#workshop-confirm-clear').addEventListener('click', () => { try { resetLocal(); clearDialog.close(); } catch { status('本機清除失敗，沒有宣告成功。請先匯出。'); } });
  document.querySelector('#confirm-clear-data')?.addEventListener('click', (event) => {
    try { resetLocal(); }
    catch { event.preventDefault(); event.stopImmediatePropagation(); const error = document.querySelector('#clear-data-error'); if (error) { error.hidden = false; error.textContent = '工坊本機資料清除未成功，尚未開始清除聊天；請先匯出。'; } }
  }, { capture: true });
  window.addEventListener('storage', (event) => {
    if (event.key === DRAFT_KEY) {
      if (event.newValue === null) { resetLocal(false); return; }
      storageConflict = true; renderStorage(); status('另一分頁更新了工坊草稿，已停止覆寫與新送出；請先匯出再重新整理。');
    }
    if (event.key === LOUNGE_KEY && event.newValue === null) { try { resetLocal(); } catch { storageError = '另一分頁確認清除後，工坊本機移除未成功；請自行確認。'; renderStorage(); } }
  });
  window.addEventListener('pagehide', () => { for (const controller of controllers) controller.abort(); });
  renderDraft(); renderOutbox(); renderPosts(); $('#workshop-feed-status').textContent = '打開工坊後才讀取共同資料庫；未啟動輪詢。';
  return { key: DRAFT_KEY, open: () => tab.click(), refresh: () => loadFeed(), root };
}
