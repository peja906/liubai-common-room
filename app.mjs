import {
  STORAGE_KEY, createState, loadState, saveState, setDraft, beginSend, confirmMessage, markUnknown,
  resolveReceipt, setBookmarked, parkQuestion, resolveQuestion, setPaused,
  startDemoRound, nextDemoMessage, stopDemoRound, DEMO_LIMIT,
} from './core.mjs';
import { ensureWiki, retainExcerpt } from './wiki-core.mjs';
import { initWikiUI } from './wiki-ui.mjs';

// This prototype has no remote adapter. The receipt ledger is synthetic and local.
const $ = (selector) => document.querySelector(selector);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const excerpt = (text, limit = 54) => text.length > limit ? `${text.slice(0, limit)}…` : text;
const byId = (id) => state.messages.find((message) => message.id === id);
let storage;
let hadRecord = false;
try { storage = window.localStorage; hadRecord = storage.getItem(STORAGE_KEY) !== null; }
catch { storage = { getItem() { throw Error('unavailable'); }, setItem() { throw Error('unavailable'); } }; }
const loaded = loadState(storage);
let state = loaded.state;
let saveError = loaded.error;
let demoTimer = null;
let toastTimer = null;
let reopenSource = state.pauseMarker?.afterId ?? state.messages.at(-1)?.id;
let activeQuestionSource = null;
let composing = false;
let clearingStorage = false;
let wikiUI = null;
const pendingTimers = new Map();
const conversation = $('#conversation');
const draft = $('#draft');
let demoNote = state.demo.round > 0 ? '上次示範已停止；需要時再播放。' : '';

function persist() {
  const result = saveState(storage, state);
  saveError = result.ok ? null : result.error;
  updateSaveState();
  wikiUI?.updateSaveHint();
  return result.ok;
}

function updateSaveState() {
  const label = $('#save-state');
  label.textContent = saveError ? '● 尚未保存' : '● 本機已保存';
  label.classList.toggle('error', Boolean(saveError));
  $('#storage-warning').hidden = !saveError;
  $('#storage-warning').textContent = saveError ?? '';
  $('#draft-status').textContent = saveError
    ? '儲存未成功，請保持此頁開啟，並在口袋筆記匯出備份。'
    : state.draft.text ? '草稿已留在本機。想好了再送出。' : '你的文字由你寫，不會自動送給示範角色。';
}

function notify(text) {
  clearTimeout(toastTimer);
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3300);
}

function clock(timestamp) {
  return new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp);
}

function avatar(author) {
  return ({ 你: ['you', '你'], 小葵: ['yua', '葵'], 阿光: ['qing', '光'], 予安: ['yua', '予'], 青禾: ['qing', '青'], 沐光: ['mu', '沐'] })[author] ?? ['guest', '客'];
}

function textMarkup(text) {
  // URLs remain text. No anchors, previews, fetching, or external navigation.
  return String(text).split(/(https?:\/\/[^\s<>]+)/g).map((part) => /^https?:\/\//.test(part) ? `<span class="url-text">${escape(part)}</span>` : escape(part)).join('');
}

function messageMarkup(message) {
  const [color, letter] = avatar(message.author);
  const parent = byId(message.replyTo);
  const bookmarked = state.bookmarks.includes(message.id);
  const isUser = message.origin === 'user';
  const linkNote = /https?:\/\//i.test(message.text) ? '<small class="link-note">連結僅存文字 · 未抓取內容</small>' : '';
  const delivery = message.status === 'unknown'
    ? `<div class="unknown-status"><strong>送出結果未知 · 示範斷線</strong><p>這則內容已保留。尚未取得本機示範收件確認，不會自動重送，也不會交給腳本接話。</p><button data-action="receipt" data-id="${escape(message.id)}">核對本機示範收件紀錄</button><code>訊息 ID：${escape(message.id)}</code></div>`
    : message.status === 'pending' ? '<div class="delivery">等待本機示範確認…</div>'
    : isUser ? '<div class="delivery">✓ 本機示範已確認 · 未傳至外部</div>' : '';
  return `${message.sceneBreak ? `<div class="scene-break">${escape(message.sceneBreak)}</div>` : ''}<article class="message ${isUser ? 'user-message' : ''}" id="${escape(message.id)}" data-message-id="${escape(message.id)}"><span class="avatar ${color}" aria-hidden="true">${letter}</span><div class="message-body"><div class="message-head"><span class="message-author">${escape(message.author)}</span><span class="origin-tag ${isUser ? 'user' : ''}">${isUser ? '本人自寫' : message.author === '訪客' ? '示範人類 · 腳本' : '示範腳本'}</span><time class="message-time" datetime="${new Date(message.createdAt).toISOString()}">${clock(message.createdAt)}</time></div>${parent ? `<button class="reply-quote" data-action="jump" data-id="${escape(parent.id)}" aria-label="回到回覆來源">↳ ${escape(parent.author)}：${escape(excerpt(parent.text, 75))}</button>` : ''}<p class="message-text">${textMarkup(message.text)}</p>${linkNote}${delivery}<div class="message-actions"><button data-action="reply" data-id="${escape(message.id)}">↳ 回覆</button><button data-action="bookmark" data-id="${escape(message.id)}" aria-pressed="${bookmarked}">${bookmarked ? '▰ 已留著' : '⌑ 留這段'}</button><button data-action="question" data-id="${escape(message.id)}">◌ 暫放疑問</button></div></div></article>`;
}

function renderMessages({ scroll = false } = {}) {
  const nearBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 95;
  const previous = conversation.scrollTop;
  $('#messages').innerHTML = state.messages.map(messageMarkup).join('');
  if (scroll || nearBottom) goBottom(false);
  else { conversation.scrollTop = previous; $('#jump-latest').hidden = false; }
}

function renderNotebook() {
  const unresolved = state.questions.filter((question) => !question.resolvedAt);
  const resolved = state.questions.filter((question) => question.resolvedAt);
  $('#question-count').textContent = unresolved.length;
  $('#saved-count').textContent = state.bookmarks.length;
  $('#notebook-count').textContent = unresolved.length + state.bookmarks.length;
  $('#questions').innerHTML = unresolved.length ? unresolved.map(questionMarkup).join('') : '<p class="empty-note">還沒有未完話題。<br>有想不完的，就暫放一下。</p>';
  if (resolved.length) {
    $('#questions').innerHTML += `<details class="resolved-questions"><summary>已接續過的線頭（${resolved.length}）</summary>${resolved.map(questionMarkup).join('')}</details>`;
  }
  $('#bookmarks').innerHTML = state.bookmarks.length ? state.bookmarks.map((id) => {
    const message = byId(id);
    return `<div class="bookmark-card"><span class="bookmark-author">${escape(message.author)} · ${message.origin === 'user' ? '本人自寫' : '示範腳本'}</span><p>${escape(message.text)}</p><div class="bookmark-actions"><button data-action="jump" data-id="${escape(id)}">回到對話 ↗</button><button data-action="bookmark" data-id="${escape(id)}">取消回看</button><button class="make-wiki" data-action="make-wiki" data-id="${escape(id)}">整理成 Wiki 本機草稿 →</button></div></div>`;
  }).join('') : '<p class="empty-note">值得重讀的片段，<br>點訊息下的「留這段」收好。</p>';
}

function questionMarkup(question) {
  const source = byId(question.sourceId);
  return `<div class="question-card ${question.resolvedAt ? 'resolved' : ''}"><p>${escape(question.text)}</p><small>你自行暫放${source ? ` · 來源：${escape(source.author)}${source.origin === 'script' ? '的示範腳本' : '的自寫訊息'}` : ''}</small><div class="question-actions"><button data-action="continue-question" data-id="${escape(question.id)}">從這裡接話 ↗</button>${question.resolvedAt ? '<span>已接續 · 原便條保留</span>' : `<button data-action="resolve-question" data-id="${escape(question.id)}">已接續過</button>`}</div>${source ? `<button class="question-source" data-action="jump" data-id="${escape(source.id)}">回到來源原句</button>` : ''}</div>`;
}

function renderControls() {
  $('#pause').textContent = state.paused ? '↶ 回來接續' : '◷ 離席一下';
  $('#pause-banner').hidden = !state.paused;
  $('#send').disabled = !draft.value.trim();
  $('#start-demo').disabled = state.paused || state.demo.running;
  $('#stop-demo').disabled = !state.demo.running;
  $('#play-demo').disabled = state.paused || state.demo.running;
  $('#start-demo').innerHTML = state.demo.running ? '演示播放中' : '展開虛構隔天 <span aria-hidden="true">▷</span>';
  $('#demo-description').textContent = state.demo.running ? '可選演示：預寫腳本，並非即時對話。' : '全文預寫，並非即時對話。';
  $('#round-status').textContent = state.demo.running ? `可選播放預寫腳本 ${state.demo.index} / ${DEMO_LIMIT}。不是即時對話。` : demoNote;
  const parent = byId(state.draft.replyTo);
  $('#reply-preview').hidden = !parent;
  $('#reply-preview span').textContent = parent ? `正在回覆 ${parent.author}：${excerpt(parent.text)}` : '';
  updateSaveState();
}

function goBottom(smooth = true) {
  requestAnimationFrame(() => { conversation.scrollTo({ top: conversation.scrollHeight, behavior: smooth ? 'smooth' : 'instant' }); });
  $('#jump-latest').hidden = true;
}

function jumpTo(id) {
  showView('chat');
  closeNotebook();
  const element = document.getElementById(id);
  if (!element || !element.matches('[data-message-id]')) return;
  element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  element.classList.add('highlight');
  setTimeout(() => element.classList.remove('highlight'), 1600);
}

function openNotebook() {
  $('#notebook').inert = false;
  $('#notebook').setAttribute('aria-hidden', 'false');
  $('#notebook').classList.add('open');
  $('#drawer-backdrop').hidden = false;
  $('#open-notebook').setAttribute('aria-expanded', 'true');
  $('#close-notebook').focus();
}
function closeNotebook() {
  const wasOpen = $('#notebook').classList.contains('open');
  $('#notebook').classList.remove('open');
  $('#notebook').inert = true;
  $('#notebook').setAttribute('aria-hidden', 'true');
  $('#drawer-backdrop').hidden = true;
  $('#open-notebook').setAttribute('aria-expanded', 'false');
  if (wasOpen) $('#open-notebook').focus();
}

function openQuestion(sourceId = null) {
  activeQuestionSource = sourceId ?? state.questionDraft?.sourceId ?? null;
  const source = byId(sourceId);
  $('#question-text').value = source ? source.text : state.questionDraft?.text ?? '';
  $('#question-dialog form>p').textContent = source
    ? '原句放在下面作為起點，請自行改寫想留下的疑問。沒有自動摘要。'
    : '下次回來，就從這個線頭接著聊。';
  $('#question-dialog').showModal();
  $('#question-text').focus();
}

function showResume(usePauseMarker = false) {
  reopenSource = usePauseMarker ? state.pauseMarker?.afterId ?? state.messages.at(-1)?.id : state.messages.at(-1)?.id;
  const last = byId(reopenSource);
  if (!last) return;
  const count = state.questions.filter((question) => !question.resolvedAt).length;
  $('#resume-copy').textContent = `上次停在 ${last.author}： 「${excerpt(last.text, 62)}」${count ? ` · ${count} 個未完話題還在。` : ''}`;
  $('#resume-banner').hidden = false;
}

function togglePause() {
  clearTimeout(demoTimer);
  if (state.paused) {
    setPaused(state, false);
    showResume(true);
    demoNote = '已回來。示範不會自動重啟，先照自己的節奏聊。';
    notify('歡迎回來。草稿與線頭都還在。');
  } else {
    setPaused(state, true);
    $('#resume-banner').hidden = true;
    demoNote = '已離席，示範停止。你仍可寫草稿，或送出自己的訊息。';
    notify('示範已停止，內容留在本機。');
  }
  persist(); renderControls();
}

function scheduleDemo() {
  clearTimeout(demoTimer);
  if (!state.demo.running || state.paused) return;
  demoTimer = setTimeout(() => {
    const message = nextDemoMessage(state);
    if (!message) return;
    if (!state.demo.running) demoNote = '這一小段結束了。接下來，留給你的節奏。';
    persist(); renderMessages(); renderControls();
    scheduleDemo();
  }, 2100);
}

function sendMessage(event) {
  event.preventDefault();
  if (!draft.value.trim() || composing) return;
  // Persist the text before moving it to a message; if storage fails, keep draft.
  setDraft(state, draft.value);
  if (!persist()) { notify('目前無法保存，文字仍在草稿。請先匯出本機備份。'); return; }
  const backup = structuredClone(state.draft);
  const message = beginSend(state, { simulateDisconnect: $('#simulate-disconnect').checked });
  if (!message) return;
  if (!persist()) {
    // Keep both the attempted message and original text in memory; never retry it.
    markUnknown(state, message.id);
    setDraft(state, backup.text, backup.replyTo);
    notify('保存未成功，結果未知。草稿保留，請勿重送；先匯出備份。');
  }
  draft.value = state.draft.text;
  renderMessages({ scroll: true }); renderControls();
  if (message.status === 'pending' && !saveError) {
    const timer = setTimeout(() => {
      if (byId(message.id)?.status !== 'pending') return;
      confirmMessage(state, message.id);
      persist(); renderMessages(); renderControls();
      pendingTimers.delete(message.id);
    }, 450);
    pendingTimers.set(message.id, timer);
  }
}

document.addEventListener('click', (event) => {
  const action = event.target.closest('button[data-action]');
  if (!action) return;
  const id = action.dataset.id;
  const message = byId(id);
  switch (action.dataset.action) {
    case 'reply':
      if (!message) return;
      setDraft(state, draft.value, id); persist(); renderControls(); draft.focus(); break;
    case 'bookmark':
      setBookmarked(state, id);
      if (state.bookmarks.includes(id) && message) retainExcerpt(state, message);
      persist(); renderMessages(); renderNotebook(); wikiUI?.refresh();
      notify(state.bookmarks.includes(id) ? '已收進「稍後回看」。' : '已取消回看，原訊息仍保留。'); break;
    case 'make-wiki':
      if (message) { closeNotebook(); wikiUI?.fromMessage(message); } break;
    case 'question': openQuestion(id); break;
    case 'jump': jumpTo(id); break;
    case 'receipt': {
      const result = resolveReceipt(state, id);
      persist(); renderMessages(); renderControls();
      notify(result.found ? '找到同一筆本機示範紀錄，已核對；沒有重送。' : '找不到本機示範收件紀錄，繼續保留未知狀態。');
      break;
    }
    case 'continue-question': {
      const question = state.questions.find((item) => item.id === id);
      if (!question) return;
      // Do not replace an existing draft. Reply context is optional.
      if (draft.value.trim()) { notify('你已有草稿，先替你保留。可從原句接話。'); if (question.sourceId) jumpTo(question.sourceId); break; }
      setDraft(state, `接著想想：${question.text}\n`, question.sourceId);
      draft.value = state.draft.text; persist(); renderControls(); closeNotebook(); draft.focus(); break;
    }
    case 'resolve-question':
      resolveQuestion(state, id); persist(); renderNotebook(); notify('線頭仍保留在「已接續過」，不會刪除。'); break;
  }
});

draft.value = state.draft.text;
draft.addEventListener('input', () => { setDraft(state, draft.value); persist(); renderControls(); });
draft.addEventListener('compositionstart', () => { composing = true; });
draft.addEventListener('compositionend', () => { composing = false; });
draft.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) sendMessage(event);
});
$('#composer').addEventListener('submit', sendMessage);
$('#cancel-reply').addEventListener('click', () => { setDraft(state, draft.value, null); persist(); renderControls(); draft.focus(); });
$('#pause').addEventListener('click', togglePause);
$('#resume').addEventListener('click', togglePause);
$('#start-demo').addEventListener('click', () => {
  if (!startDemoRound(state, byId('seed-7')?.id)) return;
  // Default action reveals the entire fixed continuation in one synchronous step.
  for (let index = 0; index < DEMO_LIMIT; index += 1) nextDemoMessage(state);
  demoNote = '虛構隔天的完整腳本已一次展開。這不是即時對話。';
  persist(); renderMessages({ scroll: true }); renderControls();
});
$('#play-demo').addEventListener('click', () => {
  if (!startDemoRound(state, byId('seed-7')?.id)) return;
  closeNotebook(); demoNote = ''; persist(); renderControls(); goBottom(); scheduleDemo();
});
$('#stop-demo').addEventListener('click', () => {
  clearTimeout(demoTimer); stopDemoRound(state); demoNote = '示範已停止。已出現的片段與你的文字都留著。';
  persist(); renderControls(); notify('已停止，沒有後續自動回合。');
});
$('#simulate-disconnect').addEventListener('change', () => {
  const checked = $('#simulate-disconnect').checked;
  if (checked) {
    for (const [id, timer] of pendingTimers) { clearTimeout(timer); markUnknown(state, id); }
    pendingTimers.clear(); persist(); renderMessages();
  }
  notify(checked ? '示範斷線已開啟，送出將顯示「結果未知」。' : '示範斷線已關閉；舊的未知訊息仍不會重送。');
});
$('#open-notebook').addEventListener('click', openNotebook);
$('#close-notebook').addEventListener('click', closeNotebook);
$('#drawer-backdrop').addEventListener('click', closeNotebook);
$('#add-question').addEventListener('click', () => openQuestion());
$('#cancel-question').addEventListener('click', () => $('#question-dialog').close());
$('#question-text').addEventListener('input', () => {
  state.questionDraft = { text: $('#question-text').value, sourceId: activeQuestionSource }; persist();
});
$('#question-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const question = parkQuestion(state, $('#question-text').value, activeQuestionSource);
  if (!question) return;
  state.questionDraft = null; persist(); renderNotebook(); $('#question-dialog').close(); notify('疑問已放入口袋，慢慢再聊。');
});
document.querySelectorAll('[data-open="connections"]').forEach((button) => button.addEventListener('click', () => $('#connections-dialog').showModal()));
$('#open-data-info').addEventListener('click', () => $('#data-info-dialog').showModal());
$('#close-data-info').addEventListener('click', () => $('#data-info-dialog').close());
$('#close-connections').addEventListener('click', () => $('#connections-dialog').close());
$('#dismiss-resume').addEventListener('click', () => { $('#resume-banner').hidden = true; });
$('#reopen-source').addEventListener('click', () => jumpTo(reopenSource));
$('#resume-question').addEventListener('click', () => { openNotebook(); $('#questions').scrollIntoView({ block: 'nearest' }); });
$('#jump-latest').addEventListener('click', () => goBottom());
conversation.addEventListener('scroll', () => {
  if (conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 50) $('#jump-latest').hidden = true;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeNotebook();
  if (event.key === 'Tab' && $('#notebook').classList.contains('open') && !document.querySelector('dialog[open]')) {
    const focusable = [...$('#notebook').querySelectorAll('button,summary')].filter((element) => element.getClientRects().length);
    const index = focusable.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0) { event.preventDefault(); focusable.at(-1)?.focus(); }
    else if (!event.shiftKey && (index === focusable.length - 1 || index === -1)) { event.preventDefault(); focusable[0]?.focus(); }
  }
});
function exportBackup() {
  const blob = new Blob([JSON.stringify({ prototype: '留白交誼廳', exportedAt: new Date().toISOString(), state }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = `留白交誼廳-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify('已建立本機備份下載，沒有上傳內容。');
}
$('#export-backup').addEventListener('click', exportBackup);
$('#clear-export-backup').addEventListener('click', exportBackup);
$('#open-clear-data').addEventListener('click', () => {
  $('#clear-data-error').hidden = true;
  $('#clear-data-dialog').showModal();
  $('#cancel-clear-data').focus();
});
$('#cancel-clear-data').addEventListener('click', () => $('#clear-data-dialog').close());
$('#confirm-clear-data').addEventListener('click', () => {
  // Only an explicit second click removes this prototype's single storage key.
  // pagehide must not re-save the old state after a successful removal.
  try {
    storage.removeItem(STORAGE_KEY);
    clearingStorage = true;
    clearTimeout(demoTimer);
    for (const timer of pendingTimers.values()) clearTimeout(timer);
    pendingTimers.clear();
    location.reload();
  } catch {
    $('#clear-data-error').textContent = '清除未成功，沒有宣告資料已清除。請先匯出備份，再透過瀏覽器的網站資料設定處理。';
    $('#clear-data-error').hidden = false;
  }
});
// Another tab must not silently overwrite this tab's content or drafts.
window.addEventListener('storage', (event) => {
  if (event.key === STORAGE_KEY) {
    if (event.newValue === null) {
      // An explicit clear in another tab also clears stale visible copies here.
      clearTimeout(demoTimer); clearTimeout(toastTimer);
      for (const timer of pendingTimers.values()) clearTimeout(timer);
      pendingTimers.clear(); state = createState(); loaded.state = state;
      draft.value = ''; activeQuestionSource = null; reopenSource = null;
      saveError = null; demoNote = '本瀏覽器的資料已由使用者在另一分頁清除。';
      for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
      $('#question-text').value = '';
      $('#resume-banner').hidden = true;
      renderMessages({ scroll: true }); renderNotebook(); renderControls(); wikiUI?.resetView();
      notify('另一分頁已確認清除資料。此頁也已移除舊內容。');
      return;
    }
    if (!state._storageBlocked) Object.defineProperty(state, '_storageBlocked', { value: true, enumerable: false, configurable: true });
    saveError = '另一個分頁改動了同一份紀錄。已停止覆寫，請先匯出此頁備份，再重新整理。';
    clearTimeout(demoTimer); stopDemoRound(state); updateSaveState(); renderControls(); wikiUI?.updateSaveHint();
  }
});
window.addEventListener('pagehide', () => {
  if (clearingStorage) return;
  clearTimeout(demoTimer); stopDemoRound(state);
  for (const [id, timer] of pendingTimers) { clearTimeout(timer); markUnknown(state, id); }
  pendingTimers.clear(); persist();
});
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  renderMessages(); renderNotebook(); renderControls(); wikiUI?.refresh();
  if (!state.paused) showResume();
});
function showView(view) {
  const isWiki = view === 'wiki';
  $('#chat-view').hidden = isWiki; $('#wiki-view').hidden = !isWiki;
  $('#tab-chat').toggleAttribute('aria-current', !isWiki); $('#tab-wiki').toggleAttribute('aria-current', isWiki);
  (isWiki ? $('#tab-wiki') : $('#tab-chat')).setAttribute('aria-current', 'page');
  if (isWiki) { closeNotebook(); wikiUI?.refresh(); wikiUI?.loadPublic(); }
  const nextHash = isWiki ? '#wiki' : '';
  if (location.hash !== nextHash) history.replaceState(null, '', location.pathname + location.search + nextHash);
}
$('#tab-chat').addEventListener('click', () => showView('chat'));
$('#tab-wiki').addEventListener('click', () => showView('wiki'));
$('#notebook-wiki').addEventListener('click', () => showView('wiki'));
window.addEventListener('hashchange', () => showView(location.hash.startsWith('#wiki') ? 'wiki' : 'chat'));
ensureWiki(state);
if (!state.wikiError) for (const id of state.bookmarks) { const message = byId(id); if (message) retainExcerpt(state, message); }
wikiUI = initWikiUI({
  getState: () => state, persist, notify, getSaveError: () => saveError,
  onOpen: showView, onPocket: openNotebook,
  onSource: (source) => {
    const message = state.messages.find((item) => (item.id === source.id && item.origin === source.origin && item.author === source.author && item.text === source.text) || (item.origin === 'script' && source.origin === 'script' && item.author === source.author && item.text === source.text));
    if (!message) return false;
    jumpTo(message.id); return true;
  },
});
showView(location.hash.startsWith('#wiki') ? 'wiki' : 'chat');

// Seed preservation and any pending -> unknown recovery are written only if load succeeded.
if (loaded.ok) persist();
renderMessages(); renderNotebook(); renderControls();
if (hadRecord && loaded.ok && !state.paused) showResume();

if (!hadRecord) requestAnimationFrame(() => conversation.scrollTo({ top: 0, behavior: 'instant' }));
