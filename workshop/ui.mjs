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
const reviewStates = ['pending', 'accepted', 'rejected', 'hidden'];
const reviewOK = (value) => reviewStates.includes(value.reviewState) && Number.isSafeInteger(value.reviewVersion) && value.reviewVersion > 0;
const reportPayload = (value) => ({ postId: value.postId, reason: value.reason.trim() });
const validReport = (value) => value && HASH.test(value.postId) && typeof value.reason === 'string' && chars(value.reason) >= 1 && chars(value.reason) <= 300;
const validState = (value) => value && value.version === 1 && validDraft(value.draft) && Array.isArray(value.outbox) && value.outbox.every((item) => item && HASH.test(item.submissionId) && validDraft(item.payload) && ['unknown', 'confirmed', 'received', 'rejected', 'not-sent'].includes(item.status) && (item.status !== 'received' || reviewOK(item)) && Number.isFinite(item.createdAt)) && (value.reports === undefined || Array.isArray(value.reports) && value.reports.every((item) => item && HASH.test(item.reportId) && validReport(item.payload) && ['unknown', 'received', 'rejected', 'not-sent'].includes(item.status) && Number.isFinite(item.createdAt)));
const asTime = (value) => Number.isFinite(value) ? new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(value) : '時間未確認';
const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), (byte) => byte.toString(16).padStart(2, '0')).join('');
const validPost = (post) => post && HASH.test(post.id) && Number.isSafeInteger(post.seq) && post.seq > 0 && ['discussion', 'proposal'].includes(post.kind) && typeof post.nickname === 'string' && chars(post.nickname) <= 24 && typeof post.body === 'string' && chars(post.body) <= 1500 && (post.replyTo === null || HASH.test(post.replyTo)) && Number.isFinite(post.createdAt) && post.identity === 'unverified-visitor' && post.verification === 'unverified' && post.publication === 'public-proposal' && post.reviewState === 'accepted' && reviewOK(post) && ['accepted', 'unavailable'].includes(post.replyAvailability);
const reviewLabel = (value) => ({ pending: '待審，尚未公開', accepted: '允許展示，內容仍未核實', rejected: '未接受展示', hidden: '已收起展示' }[value] || '狀態未確認');
const knownReject = (code, data) => [400, 403, 409, 413, 415, 422, 429, 507].includes(code) || code === 408 && data.error === 'request_read_timeout';

export function initWorkshopUI() {
  if (document.querySelector('#workshop-view')) return null;
  const nav = document.querySelector('.view-tabs');
  const main = document.querySelector('main.main');
  if (!nav || !main) throw new Error('Workshop requires the existing lounge shell');
  const tab = document.createElement('button'); tab.id = 'tab-workshop'; tab.type = 'button';
  tab.innerHTML = '共同工坊 <span>本機安全測試</span>'; nav.insertBefore(tab, document.querySelector('#open-data-info'));
  const root = document.createElement('section'); root.id = 'workshop-view'; root.className = 'workshop-view'; root.hidden = true; root.setAttribute('aria-label', '共同工坊本機安全測試'); main.append(root);
  root.innerHTML = `<div class="workshop-wrap"><header class="workshop-heading"><span class="workshop-eyebrow">共同工坊 · 本機安全測試 · 尚未上線</span><h2>把願意公開的話，留在同一張桌上。</h2><p>這裡與私人聊天、Wiki 本機草稿分開。你不必搬前情，也不會自動帶入任何私稿。</p></header><div class="workshop-boundary"><strong>送出待審，接受展示後才全網可見。</strong><p>請勿貼私人、機密或他人的個人資料。按下送出會將這一段交給本機測試資料庫待審；收件不等於公開。正式站尚未開放提交，真模型仍未連接，不能自動互通。</p></div><p id="workshop-storage-error" class="workshop-error" role="alert" hidden></p><div class="workshop-columns"><section class="workshop-compose" aria-labelledby="workshop-compose-title"><h3 id="workshop-compose-title">另外寫一段，確認後送待審</h3><p class="workshop-small">預設仍是本機草稿。沒有背景、分類或官方身分必填。</p><form id="workshop-form"><div class="workshop-fields"><div><label for="workshop-nickname">暱稱（可空白）</label><input id="workshop-nickname" maxlength="96" autocomplete="off" placeholder="訪客 · 未驗證名稱"></div><div><label for="workshop-kind">想留下</label><select id="workshop-kind"><option value="discussion">一段討論</option><option value="proposal">一個提案</option></select></div></div><p class="workshop-small">暱稱只是自填顯示名稱，不代表本人、模型或官方；請勿冒名。接受展示只代表允許顯示，所有內容仍未核實。</p><div id="workshop-reply" class="workshop-reply" hidden></div><label for="workshop-body">願意公開的內容</label><textarea id="workshop-body" rows="8" maxlength="6000" placeholder="這裡是獨立輸入框，不會讀入你的私人聊天或草稿。"></textarea><div class="workshop-draft-meta"><span id="workshop-draft-state" role="status"></span><span id="workshop-count">0／1500 字</span></div><label class="workshop-consent" for="workshop-consent"><input id="workshop-consent" type="checkbox"><span>我同意將這一段送待審，接受展示後全網可見，並確認沒有私人或機密資料。</span></label><button id="workshop-send" class="primary-small" type="submit">送出待審（本機安全測試）</button></form><p id="workshop-submit-status" class="workshop-submit-status" role="status" aria-live="polite"></p><div id="workshop-outbox"></div><section class="workshop-reports" aria-label="我的本機回報收件紀錄"><div id="workshop-report-outbox"></div><p id="workshop-report-status" class="workshop-submit-status" role="status" aria-live="polite"></p></section><div class="workshop-local-actions"><button id="workshop-export" type="button" class="text-button">匯出工坊本機草稿與收件紀錄</button><button id="workshop-clear" type="button" class="text-button">清除工坊本機資料</button></div></section><section class="workshop-feed" aria-labelledby="workshop-feed-title"><div class="workshop-feed-heading"><div><h3 id="workshop-feed-title">同一份討論與提案</h3><p class="workshop-small">本機共同資料庫 · 只展示已接受項目 · 仍未核實</p></div><button id="workshop-refresh" class="quiet-button" type="button">重新讀取</button></div><p id="workshop-feed-status" class="workshop-small" role="status"></p><div id="workshop-posts"></div><button id="workshop-older" class="quiet-button" type="button" hidden>讀取較早的 20 則</button><p class="workshop-footnote">公眾只能新增提案，不能覆寫公共 Wiki 或刪改他人內容。完全相同的內容會合併成同一則；暱稱不能當作身分證明。沒有自動輪詢。</p></section></div></div>`;
  const clearDialog = document.createElement('dialog'); clearDialog.id = 'workshop-clear-dialog'; clearDialog.setAttribute('aria-labelledby', 'workshop-clear-title');
  clearDialog.innerHTML = `<h2 id="workshop-clear-title">清除工坊本機資料？</h2><p>會清除此瀏覽器的工坊草稿、回覆選擇、回報表單與全部投稿／回報收件紀錄，包含仍未知的結果。共同資料庫內已收件或公開內容不會刪除，也不會影響私人聊天及 Wiki 草稿。可先匯出；確認後不能在此復原。</p><button type="button" class="text-button" id="workshop-export-before-clear">先匯出工坊本機備份</button><div class="dialog-actions"><button type="button" class="quiet-button" id="workshop-cancel-clear">保留資料</button><button type="button" class="danger-button" id="workshop-confirm-clear">確認清除工坊本機資料</button></div>`;
  document.body.append(clearDialog);
  const reportDialog = document.createElement('dialog'); reportDialog.id = 'workshop-report-dialog'; reportDialog.setAttribute('aria-labelledby', 'workshop-report-title');
  reportDialog.innerHTML = `<h2 id="workshop-report-title">回報這一則</h2><p>只送出所選公開項目的識別碼與你另外寫的短理由，不會附上正文快照、私人聊天、Wiki 或投稿草稿。請勿在理由貼私人或機密內容。回報收件不表示已處理，也不會自動隱藏內容。</p><p>所選項目 ID：<code id="workshop-report-target"></code></p><form id="workshop-report-form"><label for="workshop-report-reason">短理由（1–300 字）</label><textarea id="workshop-report-reason" rows="4" maxlength="1200" autocomplete="off"></textarea><p id="workshop-report-count" class="workshop-small">0／300 字</p><p id="workshop-report-form-status" class="workshop-small" role="status"></p><p id="workshop-report-result" class="workshop-submit-status" role="status" aria-live="polite"></p><div class="dialog-actions"><button id="workshop-report-cancel" type="button" class="quiet-button">保留在此頁，不送出</button><button id="workshop-report-send" type="submit" class="primary-small">確認送出回報（本機測試）</button></div></form>`;
  document.body.append(reportDialog);
  document.querySelector('.clear-scope')?.insertAdjacentHTML('beforeend', '<li data-workshop-clear-scope>工坊本機草稿、回報與投稿收件紀錄（不刪共同資料庫；工坊備份請另按下方匯出）</li>');
  const globalExport = document.createElement('button'); globalExport.type = 'button'; globalExport.id = 'workshop-export-in-global-clear'; globalExport.className = 'backup-before-clear'; globalExport.textContent = '另匯出工坊本機備份 ↗'; document.querySelector('#clear-data-dialog .dialog-actions')?.before(globalExport);
  const $ = (selector) => root.querySelector(selector);
  let state = empty(), rawRecord = null, storageError = '', storageConflict = false, busy = false, generation = 0, reportTarget = null;
  let posts = [], nextCursor = null, feedLoaded = false, feedBusy = false, writes = 'unknown';
  const controllers = new Set();
  try { rawRecord = localStorage.getItem(DRAFT_KEY); if (rawRecord !== null) { const parsed = JSON.parse(rawRecord); if (!validState(parsed)) throw new Error('invalid'); state = parsed; } }
  catch { storageError = '工坊本機紀錄無法讀取，原資料保留；目前禁止送出，請先匯出或自行確認清除。'; }

  function save() {
    if (storageError || storageConflict) { renderStorage(); return false; }
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(state)); return true; }
    catch { storageError = '工坊本機保存未成功。請保持此頁開啟並匯出；收件不等於公開，請另看審閱狀態。'; renderStorage(); return false; }
  }
  function pending() { return state.outbox.find((item) => item.status === 'unknown'); }
  const reportItems = () => state.reports ?? [];
  const pendingReport = () => reportItems().find((item) => item.status === 'unknown');
  const reportField = (selector) => reportDialog.querySelector(selector);
  function renderReportForm() {
    const available = posts.some((post) => post.id === reportTarget);
    reportField('#workshop-report-send').disabled = Boolean(storageError || storageConflict || busy || pendingReport() || writes !== 'enabled' || !available);
    reportField('#workshop-report-form-status').textContent = !reportTarget ? '' : !available ? '這個項目目前不可見，無法回報；沒有送出。' : pendingReport() ? '先處理上一筆未知回報；不會自動重送。' : '按下確認才傳送 ID 與這段短理由。';
  }
  function renderStorage() {
    const error = storageError || (storageConflict ? '另一分頁改動工坊紀錄，已停止覆寫。請匯出此頁，再重新整理。' : '');
    $('#workshop-storage-error').hidden = !error; $('#workshop-storage-error').textContent = error;
    $('#workshop-draft-state').textContent = error ? '此頁內容尚未保存' : '草稿僅本機，尚未公開';
    $('#workshop-send').disabled = Boolean(error || busy || pending() || writes !== 'enabled');
    renderReportForm();
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
    $('#workshop-outbox').innerHTML = `${unresolved ? `<section class="workshop-unknown" data-submission-id="${escape(unresolved.submissionId)}"><strong>這次投稿收件結果未知</strong><p>不把未知當作成功，也不會自動重送。新草稿可以繼續寫；請先查這筆收件結果，再處理同一筆送出。</p><blockquote>${escape(unresolved.payload.body)}</blockquote><small>${asTime(unresolved.createdAt)} · 內容與識別碼已留在本機</small><p>${escape(unresolved.note || '')}</p><div class="workshop-receipt-actions"><button type="button" class="quiet-button" data-workshop-action="check" data-id="${escape(unresolved.submissionId)}" ${busy ? 'disabled' : ''}>查詢這次送出結果</button><button type="button" class="text-button" data-workshop-action="resend" data-id="${escape(unresolved.submissionId)}" ${busy ? 'disabled' : ''}>再送同一筆待審內容</button></div></section>` : ''}${history.length ? `<details class="workshop-receipt-history"><summary>本機投稿收件紀錄（${history.length}）</summary>${[...history].reverse().map((item) => `<article data-submission-id="${escape(item.submissionId)}"><strong>${item.status === 'received' ? `已收件 · ${reviewLabel(item.reviewState)} · 狀態第 ${item.reviewVersion} 版` : item.status === 'confirmed' ? '舊版本收件確認 · 目前展示狀態未重查' : item.status === 'not-sent' ? '未發出請求' : item.status === 'unknown' ? '送出結果仍未知' : '伺服器未接受這次送出'}</strong><p>${escape(item.payload.body)}</p><small>${asTime(item.createdAt)} · ${escape(item.note || '')}</small>${['received', 'confirmed'].includes(item.status) ? `<button type="button" class="text-button" data-workshop-action="check" data-id="${escape(item.submissionId)}" ${busy ? 'disabled' : ''}>只查目前審閱狀態</button>` : ''}</article>`).join('')}</details>` : ''}`;
    renderReportOutbox();
    renderStorage();
  }
  function renderReportOutbox() {
    const unresolved = pendingReport();
    $('#workshop-report-outbox').innerHTML = reportItems().length ? `<h3>我的回報收件紀錄 · 僅本機</h3>${reportItems().map((item) => `<article class="${item === unresolved ? 'workshop-unknown' : 'workshop-report-record'}" data-report-id="${escape(item.reportId)}"><strong>${item.status === 'received' ? '回報已收件，尚不代表已處理' : item.status === 'unknown' ? '回報收件結果未知' : item.status === 'not-sent' ? '未發出回報請求' : '伺服器未接受這次回報'}</strong><p>所選項目 ID：<code>${escape(item.payload.postId)}</code></p><p class="workshop-report-reason">${escape(item.payload.reason)}</p><small>${asTime(item.createdAt)} · ${escape(item.note || '')}</small>${item.status === 'unknown' ? `<div class="workshop-receipt-actions"><button type="button" class="quiet-button" data-workshop-action="report-check" data-id="${escape(item.reportId)}" ${busy ? 'disabled' : ''}>查詢這次回報收件</button><button type="button" class="text-button" data-workshop-action="report-resend" data-id="${escape(item.reportId)}" ${busy ? 'disabled' : ''}>再送同一筆回報</button></div>` : ''}</article>`).join('')}` : '';
  }
  function renderPosts() {
    $('#workshop-posts').innerHTML = posts.length ? posts.map((post) => `<article class="workshop-post" data-public-post-id="${escape(post.id)}"><header><strong>訪客自填・未驗證：${escape(post.nickname)}</strong><span>${post.kind === 'proposal' ? '提案' : '討論'}</span></header>${post.replyTo ? `<p class="workshop-public-reply">回覆項目 ${escape(post.replyTo.slice(0, 12))}…${post.replyAvailability === 'unavailable' ? ' · 來源目前不可見' : ' · 來源允許展示，未核實'}</p>` : ''}<p class="workshop-post-body">${escape(post.body)}</p><footer><span>${asTime(post.createdAt)} · 允許展示／未核實</span><button type="button" class="text-button" data-workshop-action="reply" data-id="${escape(post.id)}">回覆這一則公開內容</button><button type="button" class="text-button" data-workshop-action="report" data-id="${escape(post.id)}">回報這一則</button></footer></article>`).join('') : '<p class="workshop-empty">目前沒有允許展示的內容。<br>投稿收件後先待審，不會立即公開。</p>';
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
      if (code !== 200 || data.schema !== 'liubai-workshop' || data.schemaVersion !== 2 || !Array.isArray(data.posts) || data.posts.length > 20 || !data.posts.every(validPost) || !Array.isArray(data.visibleIds) || data.visibleIds.length > 200 || !data.visibleIds.every((id) => HASH.test(id)) || new Set(data.visibleIds).size !== data.visibleIds.length || !data.posts.every((post) => data.visibleIds.includes(post.id)) || !['enabled', 'disabled'].includes(data.writes) || !(data.nextCursor === null || Number.isSafeInteger(data.nextCursor) && data.nextCursor > 0)) throw new Error('invalid-feed');
      const visible = new Set(data.visibleIds);
      posts = (older ? [...new Map([...posts, ...data.posts].map((post) => [post.id, post])).values()] : data.posts).filter((post) => visible.has(post.id)).map((post) => post.replyTo ? { ...post, replyAvailability: visible.has(post.replyTo) ? 'accepted' : 'unavailable' } : post);
      nextCursor = data.nextCursor; writes = data.writes; feedLoaded = true;
      $('#workshop-feed-status').textContent = writes === 'enabled' ? '已讀取允許展示的本機共同內容；新投稿先待審，正式站未上線。' : '已讀取共同內容；伺服器已關閉提交，無法送出待審。';
      renderPosts(); renderDraft();
    } catch { if (current === generation) { writes = 'unknown'; posts = []; nextCursor = null; renderPosts(); renderDraft(); $('#workshop-feed-status').textContent = '共同資料庫目前無法確認，已收起這次讀取的公共內容；本機草稿與收件紀錄保留，沒有宣告共享成功。請手動重讀。'; } }
    finally { feedBusy = false; $('#workshop-refresh').disabled = false; $('#workshop-older').disabled = false; renderStorage(); }
  }
  async function exactReceipt(item, data) {
    return data.status === 'received' && data.submissionId === item.submissionId && reviewOK(data) && Object.keys(data).every((key) => ['status', 'submissionId', 'reviewState', 'reviewVersion', 'duplicate'].includes(key)) && (data.duplicate === undefined || typeof data.duplicate === 'boolean') && await digest(canonical(item.payload)) === item.submissionId;
  }
  function accept(item, data, current) {
    if (current !== generation) return;
    item.status = 'received'; item.reviewState = data.reviewState; item.reviewVersion = data.reviewVersion; item.note = '只確認收件與審閱狀態，不代表內容核實、身分認證或模型收到。'; item.confirmedAt = Date.now();
    if (equalPayload(state.draft, item.payload)) state.draft = { ...empty().draft, nickname: state.draft.nickname };
    const stored = save(); $('#workshop-consent').checked = false; renderDraft(); renderOutbox();
    status(stored ? `${data.duplicate === true ? '相同內容已收件，沒有新增重複。' : '已確認投稿收件。'}${reviewLabel(data.reviewState)}（狀態第 ${data.reviewVersion} 版）。收件不等於公開、身分認證或模型收到；私人聊天及 Wiki 沒有上傳。` : '資料庫已確認收件，但本機收件狀態未保存；請匯出並保持此頁。');
    loadFeed();
  }
  async function sendItem(item) {
    if (busy || storageError || storageConflict) return;
    busy = true; const current = generation; renderOutbox(); status('正在送出你明確同意的這一筆待審內容…');
    try {
      const { status: code, data } = await request('/api/workshop/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...item.payload, submissionId: item.submissionId }) });
      if (current !== generation) return;
      if ((code === 200 || code === 201) && await exactReceipt(item, data)) { accept(item, data, current); return; }
      if (current !== generation) return;
      if (knownReject(code, data)) {
        item.status = 'rejected'; item.note = code === 429 ? '提交頻率上限，伺服器未接受。可修改或稍後自行送出，沒有自動重試。' : code === 507 ? '共同資料容量已達上限，伺服器未接受。' : '伺服器未接受。請檢查字數、暱稱及公開內容；原稿仍在本機。'; save(); renderOutbox(); status(item.note);
      } else { item.note = '沒有取得可核對的資料庫收件結果。'; save(); renderOutbox(); status('送出結果未知，請手動查詢；不會自動重送。'); }
    } catch { if (current === generation) { item.note = '連線或回應中斷，不能確認是否已寫入。'; save(); renderOutbox(); status('送出結果未知，內容與識別碼留在本機；不會自動重送。'); } }
    finally { busy = false; renderOutbox(); }
  }
  async function checkItem(item) {
    if (busy) return; busy = true; const current = generation; renderOutbox(); status('只查詢收件與審閱狀態，不重送內容；內容指紋不代表身分或私密權限。');
    try {
      const { status: code, data } = await request('/api/workshop/receipt/' + item.submissionId);
      if (current !== generation) return;
      if (code === 200 && await exactReceipt(item, data)) { accept(item, data, current); return; }
      if (current !== generation) return;
      item.note = code === 404 && data.status === 'not_found' ? '本次目前查無此筆，不等於證明它從未送達；保留先前本機紀錄，沒有重送。' : '本次沒有可核對的收件結果，保留先前本機紀錄，沒有重送。'; save(); renderOutbox(); status(item.note);
    } catch { if (current === generation) status('查詢未成功，保留先前本機紀錄；沒有重送，也不宣告目前展示狀態。'); }
    finally { busy = false; renderOutbox(); }
  }
  function reportStatus(text) { $('#workshop-report-status').textContent = text; reportField('#workshop-report-result').textContent = text; }
  async function exactReportReceipt(item, data) {
    return data.status === 'received' && data.reportId === item.reportId && Object.keys(data).length === 2 && await digest(reportPayload(item.payload)) === item.reportId;
  }
  function receiveReport(item, current) {
    if (current !== generation) return;
    item.status = 'received'; item.note = '只確認回報收件，不代表已處理或已隱藏內容。'; item.confirmedAt = Date.now();
    if (reportTarget === item.payload.postId && reportField('#workshop-report-reason').value.trim() === item.payload.reason) { reportField('#workshop-report-reason').value = ''; reportField('#workshop-report-count').textContent = '0／300 字'; }
    const stored = save(); renderOutbox();
    reportStatus(stored ? item.note : '回報已確認收件，但本機紀錄未保存；請匯出並保持此頁。不代表已處理。');
  }
  async function sendReport(item) {
    if (busy || storageError || storageConflict) return;
    busy = true; const current = generation; renderOutbox(); reportStatus('正在送出你確認的項目 ID 與短理由…');
    try {
      const { status: code, data } = await request('/api/workshop/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...item.payload, reportId: item.reportId }) });
      if (current !== generation) return;
      if ((code === 200 || code === 201) && await exactReportReceipt(item, data)) { receiveReport(item, current); return; }
      if (current !== generation) return;
      if (knownReject(code, data)) {
        item.status = 'rejected'; item.note = data.error === 'target_not_accepted' ? '所選項目目前不允許展示，伺服器未接受這次回報。' : code === 429 ? '提交頻率已達上限，伺服器未接受這次回報。' : code === 507 ? '共同資料容量已達上限，伺服器未接受這次回報。' : '伺服器未接受這次回報；理由仍留在本機。';
      } else { item.note = '沒有取得可核對的回報收件結果，仍未知；不會自動重送。'; }
      save(); renderOutbox(); reportStatus(item.note);
    } catch { if (current === generation) { item.note = '回報連線或回應中斷，收件結果未知；不會自動重送。'; save(); renderOutbox(); reportStatus(item.note); } }
    finally { busy = false; renderOutbox(); }
  }
  async function checkReport(item) {
    if (busy) return; busy = true; const current = generation; renderOutbox(); reportStatus('只查詢這筆回報是否收件，不重送理由…');
    try {
      const { status: code, data } = await request('/api/workshop/report-receipt/' + item.reportId);
      if (current !== generation) return;
      if (code === 200 && await exactReportReceipt(item, data)) { receiveReport(item, current); return; }
      if (current !== generation) return;
      item.note = code === 404 && data.status === 'not_found' ? '目前查無此筆回報，仍未知；不等於證明從未送達，沒有重送。' : '目前沒有可核對的回報收件結果，仍未知，沒有重送。'; save(); renderOutbox(); reportStatus(item.note);
    } catch { if (current === generation) reportStatus('回報查詢未成功，仍未知；沒有重送，也沒有宣告已處理。'); }
    finally { busy = false; renderOutbox(); }
  }
  function exportLocal() {
    const payload = { schema: 'liubai-workshop-local-backup', version: 1, exportedAt: new Date().toISOString(), state, reportFormInThisPage: reportTarget ? { postId: reportTarget, reason: reportField('#workshop-report-reason').value } : undefined, unreadableOriginalRecord: storageError && rawRecord !== null ? rawRecord : undefined };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `留白工坊-本機備份-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); status('已建立本機備份下載，沒有上傳。');
  }
  function resetLocal(remove = true) {
    if (remove) localStorage.removeItem(DRAFT_KEY);
    generation += 1; for (const controller of controllers) controller.abort(); controllers.clear();
    state = empty(); rawRecord = null; storageError = ''; storageConflict = false; busy = false;
    reportTarget = null; reportField('#workshop-report-target').textContent = ''; reportField('#workshop-report-reason').value = ''; reportField('#workshop-report-count').textContent = '0／300 字'; reportStatus(''); if (reportDialog.open) reportDialog.close();
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
    if (!$('#workshop-consent').checked) { status('請先確認將這段送待審，接受展示後全網可見，且沒有私人或機密內容。'); $('#workshop-consent').focus(); return; }
    const payload = canonical(state.draft);
    if (!payload.body || chars(payload.body) > 1500 || chars(payload.nickname) > 24) { status('內容需為 1–1500 字，暱稱最多 24 字；請修正後再勾選公開同意。'); return; }
    busy = true; renderStorage();
    const current = generation;
    try {
      const submissionId = await digest(payload); if (current !== generation) return;
      const known = state.outbox.find((item) => item.submissionId === submissionId && ['confirmed', 'received'].includes(item.status));
      if (known) { status('相同內容已有本機收件紀錄，沒有再次送出；這不等於目前允許公開展示。可手動查審閱狀態。'); return; }
      const item = { submissionId, payload, status: 'unknown', createdAt: Date.now(), note: '已記下這筆內容與識別碼，等待資料庫回應。' }; state.outbox.push(item);
      if (!save()) { item.status = 'not-sent'; item.note = '本機未能先保存收件識別，未發出網路請求；原稿、內容與識別碼仍在此頁，可匯出。'; status(item.note); return; }
      busy = false; await sendItem(item);
    } catch { status('未能準備送出識別碼，沒有送出內容。'); }
    finally { busy = false; renderOutbox(); }
  });
  reportField('#workshop-report-reason').addEventListener('input', () => { reportField('#workshop-report-count').textContent = `${chars(reportField('#workshop-report-reason').value)}／300 字`; });
  reportField('#workshop-report-cancel').addEventListener('click', () => reportDialog.close());
  reportField('#workshop-report-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || pendingReport() || storageError || storageConflict || writes !== 'enabled' || !posts.some((post) => post.id === reportTarget)) return;
    const payload = reportPayload({ postId: reportTarget, reason: reportField('#workshop-report-reason').value });
    if (!validReport(payload)) { reportStatus('請另外寫 1–300 字的短理由，勿貼私人或機密內容；尚未送出。'); return; }
    busy = true; renderStorage(); const current = generation;
    try {
      const reportId = await digest(payload); if (current !== generation) return;
      if (reportItems().some((item) => item.reportId === reportId && item.status === 'received')) { reportStatus('相同回報已有收件紀錄，沒有重複送出；這不表示已處理。'); return; }
      const item = { reportId, payload, status: 'unknown', createdAt: Date.now(), note: '已記下回報內容與識別碼，等待資料庫收件結果。' };
      if (state.reports === undefined) state.reports = []; state.reports.push(item);
      if (!save()) { item.status = 'not-sent'; item.note = '本機未能先保存回報識別，未發出網路請求；理由與識別碼仍在此頁，可匯出。'; reportStatus(item.note); return; }
      busy = false; await sendReport(item);
    } catch { reportStatus('未能準備回報識別碼，沒有送出理由。'); }
    finally { busy = false; renderOutbox(); }
  });
  root.addEventListener('click', async (event) => {
    const target = event.target.closest('[data-workshop-action]'); if (!target) return;
    const action = target.dataset.workshopAction;
    if (action === 'reply') { const post = posts.find((item) => item.id === target.dataset.id); if (!post) return; state.draft.replyTo = post.id; $('#workshop-consent').checked = false; save(); renderDraft(); $('#workshop-body').focus(); }
    if (action === 'cancel-reply') { state.draft.replyTo = null; $('#workshop-consent').checked = false; save(); renderDraft(); }
    if (action === 'check' || action === 'resend') { const item = state.outbox.find((entry) => entry.submissionId === target.dataset.id && (action === 'check' ? ['unknown', 'received', 'confirmed'].includes(entry.status) : entry.status === 'unknown')); if (!item) return; if (action === 'check') await checkItem(item); else await sendItem(item); }
    if (action === 'report') {
      if (!posts.some((post) => post.id === target.dataset.id)) return;
      reportTarget = target.dataset.id; reportField('#workshop-report-target').textContent = reportTarget; reportField('#workshop-report-reason').value = ''; reportField('#workshop-report-count').textContent = '0／300 字'; reportStatus(''); renderReportForm(); reportDialog.showModal(); reportField('#workshop-report-reason').focus();
    }
    if (action === 'report-check' || action === 'report-resend') { const item = reportItems().find((entry) => entry.reportId === target.dataset.id && entry.status === 'unknown'); if (!item) return; if (action === 'report-check') await checkReport(item); else await sendReport(item); }
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
