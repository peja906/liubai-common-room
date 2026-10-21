/** Local-only lounge state. No transport, credentials, timers, or DOM access. */
export const STORAGE_KEY = 'lounge.prototype.v1';
export const DEMO_LIMIT = 3;
export const PARTICIPANTS = Object.freeze([
  { name: '小葵', role: '帶來一張老照片', color: 'moss' },
  { name: '阿光', role: '一起追問線索', color: 'amber' },
]);
export const SCENE_INFO = Object.freeze({
  id: 'old-park-photo', title: '老公園照片與豆花攤', synthetic: true,
  mediaNote: '純文字合成情節；未附照片，未抓取外部內容。',
});

let sequence = 0;
const stamp = () => Date.now();
const makeId = (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${stamp().toString(36)}-${++sequence}`}`;
const touch = (state) => { state.updatedAt = stamp(); };
const messageById = (state, id) => state.messages.find((message) => message.id === id);
const validTimestamp = (value) => typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
const replyId = (state, id) => messageById(state, id) ? id : null;
const seedTexts = [
  ['小葵', '這張老公園照片裡，榕樹才到腰高。社區通訊說，是一位郵差為了讓人躲雨種的。'],
  ['阿光', '我還不能確定是郵差種的。石碑角落像寫著『林園』，也可能是別的名字。通訊有說消息從哪來嗎？'],
  ['小葵', '沒有。連躲雨的動機也先別當真。倒是右下角那台推車，我好像認得。'],
  ['阿光', '是豆花攤嗎？樹的來歷還沒弄清，倒先找到一個好吃的岔路。'],
  ['小葵', '對，加粉圓的那家！後來不見了，不知道搬去哪裡。'],
  ['阿光', '那就有兩條線：樹是誰種的，還有豆花攤去哪了。不一定今天都要找到答案。'],
  ['小葵', '今天先到這，我回去問問我爸。他可能還記得那攤。'],
];

export function createState(now = stamp()) {
  const messages = seedTexts.map(([author, text], index) => ({
    id: `seed-${index + 1}`, author, text, origin: 'script', status: 'confirmed',
    replyTo: null,
    createdAt: now - (seedTexts.length - 1 - index) * 60_000,
  }));
  return {
    version: 1, messages, receipts: [], draft: { text: '', replyTo: null },
    questions: [], bookmarks: [], paused: false, pauseMarker: null,
    lastResumedAt: null, demo: { running: false, round: 0, index: 0, replyTo: null },
    updatedAt: now,
  };
}

function validState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.messages) || !value.draft
    || !Array.isArray(value.questions) || !Array.isArray(value.bookmarks)
    || !Array.isArray(value.receipts) || !value.demo) return false;
  if (typeof value.draft.text !== 'string' || !Number.isInteger(value.demo.round)
    || !Number.isInteger(value.demo.index) || value.demo.round < 0
    || value.demo.index < 0 || value.demo.index > DEMO_LIMIT) return false;
  const ids = new Set();
  for (const message of value.messages) {
    if (!message || typeof message.id !== 'string' || ids.has(message.id)
      || typeof message.text !== 'string' || typeof message.author !== 'string'
      || !['user', 'script'].includes(message.origin)
      || !['confirmed', 'pending', 'unknown'].includes(message.status)
      || !validTimestamp(message.createdAt)) return false;
    ids.add(message.id);
  }
  return value.receipts.every((id) => typeof id === 'string' && ids.has(id))
    && value.bookmarks.every((id) => typeof id === 'string' && ids.has(id))
    && value.questions.every((question) => question && typeof question.id === 'string'
      && typeof question.text === 'string' && validTimestamp(question.createdAt));
}

/** Never overwrite an unreadable existing record with a fresh room. */
export function loadState(storage) {
  let raw;
  try {
    raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return { ok: true, state: createState(), error: null };
    const state = JSON.parse(raw);
    if (!validState(state)) throw new Error('invalid-state');
    for (const message of state.messages) {
      if (message.status === 'pending') message.status = 'unknown';
    }
    state.demo.running = false;
    state.draft.replyTo = replyId(state, state.draft.replyTo);
    return { ok: true, state, error: null };
  } catch {
    const state = createState();
    Object.defineProperty(state, '_storageBlocked', { value: true, enumerable: false });
    return { ok: false, state, error: '無法讀取本機紀錄；原紀錄未被覆寫。目前內容只保留在此頁面。' };
  }
}

export function saveState(storage, state) {
  if (state._storageBlocked) {
    return { ok: false, state, error: '原本的本機紀錄無法讀取，已停止覆寫；請先匯出此頁內容。' };
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return { ok: true, state, error: null };
  } catch {
    return { ok: false, state, error: '本機儲存未成功；請保持此頁開啟並匯出內容備份。' };
  }
}

export function setDraft(state, text, replyTo = state.draft.replyTo) {
  state.draft = { text: String(text), replyTo: replyId(state, replyTo) };
  touch(state);
  return state.draft;
}

/** A demo inbox records the same ID; its acknowledgement may be withheld. */
export function beginSend(state, options = {}) {
  const text = String(options.text ?? state.draft.text);
  if (!text.trim()) return null;
  const message = {
    id: makeId('message'), author: '你', origin: 'user', text,
    replyTo: replyId(state, options.replyTo === undefined ? state.draft.replyTo : options.replyTo),
    status: options.simulateDisconnect ? 'unknown' : 'pending', createdAt: stamp(),
  };
  state.messages.push(message);
  state.receipts.push(message.id);
  state.draft = { text: '', replyTo: null };
  touch(state);
  return message;
}

export function confirmMessage(state, id) {
  const message = messageById(state, id);
  if (!message || !state.receipts.includes(id)) return null;
  message.status = 'confirmed';
  touch(state);
  return message;
}

export function markUnknown(state, id) {
  const message = messageById(state, id);
  if (!message || message.status === 'confirmed') return null;
  message.status = 'unknown';
  touch(state);
  return message;
}

/** This inspects only a synthetic local receipt, never retries a send. */
export function resolveReceipt(state, id) {
  const message = messageById(state, id);
  if (!message || !state.receipts.includes(id)) return { found: false, message: message ?? null };
  return { found: true, message: confirmMessage(state, id) };
}

export function setBookmarked(state, id, enabled = !state.bookmarks.includes(id)) {
  if (!messageById(state, id)) return false;
  const index = state.bookmarks.indexOf(id);
  if (enabled && index === -1) state.bookmarks.push(id);
  if (!enabled && index !== -1) state.bookmarks.splice(index, 1);
  touch(state);
  return enabled;
}

export function parkQuestion(state, text, sourceId = null) {
  if (!String(text).trim()) return null;
  const question = {
    id: makeId('question'), text: String(text).trim(), sourceId: replyId(state, sourceId),
    createdAt: stamp(), resolvedAt: null,
  };
  state.questions.push(question);
  touch(state);
  return question;
}

export function resolveQuestion(state, id) {
  const question = state.questions.find((item) => item.id === id);
  if (!question) return null;
  question.resolvedAt = stamp();
  touch(state);
  return question;
}

export function stopDemoRound(state) {
  state.demo.running = false;
  touch(state);
  return state.demo;
}

export function setPaused(state, paused) {
  const next = Boolean(paused);
  if (next === state.paused) return state.paused;
  state.paused = next;
  stopDemoRound(state);
  if (next) {
    state.pauseMarker = {
      at: stamp(), afterId: state.messages.at(-1)?.id ?? null,
      messageCount: state.messages.length,
    };
  } else {
    state.lastResumedAt = stamp();
  }
  touch(state);
  return state.paused;
}

export function startDemoRound(state, replyTo = null) {
  if (state.paused || state.demo.running) return false;
  state.demo = { running: true, round: state.demo.round + 1, index: 0, replyTo: replyId(state, replyTo) };
  touch(state);
  return true;
}

const SCRIPT = [
  ['阿光', '接著昨天的老照片聊吧。你爸知道豆花攤後來去哪裡嗎？'],
  ['小葵', '搬到市場後面。他還說郵差姓林，但姓林的人很多，不能光靠這個就認定石碑是他的。'],
  ['阿光', '那先去找豆花，樹的來歷留著慢慢問。兩件事可以一起好奇，不必硬湊成一個答案。'],
];

export function nextDemoMessage(state) {
  if (state.paused || !state.demo.running || state.demo.index >= DEMO_LIMIT) return null;
  const index = state.demo.index;
  const message = {
    id: makeId('demo'), author: SCRIPT[index][0], origin: 'script',
    text: SCRIPT[index][1], replyTo: replyId(state, state.demo.replyTo),
    status: 'confirmed', createdAt: stamp(),
  };
  if (index === 0) {
    message.sceneBreak = '示範時間切換：隔天（虛構情節，並非實際經過一天）';
  }
  state.messages.push(message);
  state.demo.replyTo = message.id;
  state.demo.index += 1;
  if (state.demo.index >= DEMO_LIMIT) state.demo.running = false;
  touch(state);
  return message;
}
