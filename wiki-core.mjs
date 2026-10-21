/** Wiki data only. No DOM, network, credentials, storage, or publication writes. */
const LOCAL = 'local-private';
const UNVERIFIED = 'unverified';
const now = () => Date.now();
let sequence = 0;
const id = (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${now().toString(36)}-${++sequence}`}`;
const copy = (value) => JSON.parse(JSON.stringify(value));
const dateOK = (value) => typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const unique = (values) => [...new Set(values)];

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

const canonicalDialogue = [
  ['seed-1', '小葵', '這張老公園照片裡，榕樹才到腰高。社區通訊說，是一位郵差為了讓人躲雨種的。'],
  ['seed-2', '阿光', '我還不能確定是郵差種的。石碑角落像寫著『林園』，也可能是別的名字。通訊有說消息從哪來嗎？'],
  ['seed-3', '小葵', '沒有。連躲雨的動機也先別當真。倒是右下角那台推車，我好像認得。'],
  ['seed-4', '阿光', '是豆花攤嗎？樹的來歷還沒弄清，倒先找到一個好吃的岔路。'],
  ['seed-5', '小葵', '對，加粉圓的那家！後來不見了，不知道搬去哪裡。'],
  ['seed-6', '阿光', '那就有兩條線：樹是誰種的，還有豆花攤去哪了。不一定今天都要找到答案。'],
  ['seed-7', '小葵', '今天先到這，我回去問問我爸。他可能還記得那攤。'],
  ['scene-nextday-1', '阿光', '接著昨天的老照片聊吧。你爸知道豆花攤後來去哪裡嗎？'],
  ['scene-nextday-2', '小葵', '搬到市場後面。他還說郵差姓林，但姓林的人很多，不能光靠這個就認定石碑是他的。'],
  ['scene-nextday-3', '阿光', '那先去找豆花，樹的來歷留著慢慢問。兩件事可以一起好奇，不必硬湊成一個答案。'],
];

export const SOURCE_CATALOG = freeze(canonicalDialogue.map(([sourceId, author, text], index) => ({
  id: sourceId, messageId: sourceId, author, text, origin: 'script', status: 'confirmed',
  scope: 'public-synthetic', verification: UNVERIFIED, synthetic: true,
  sourceKind: 'synthetic-dialogue', sceneId: 'old-park-photo',
  sceneLabel: index < 7 ? '共創虛構場景原句' : '虛構隔天的預寫原句，並非實際經過一天',
  createdAt: null, capturedAt: null,
})));

const sections = [
  {
    title: '對話裡的描述',
    text: '小葵說照片中的榕樹約到腰高，右下角有推車；她轉述社區通訊稱郵差為了讓人躲雨種樹，又轉述父親說豆花攤搬到市場後面、郵差姓林。這些是角色說法，不是外部已核實事實。',
    sourceIds: ['seed-1', 'seed-3', 'scene-nextday-2'],
  },
  {
    title: '仍不確定',
    text: '阿光只說石碑字『像林園』，碑字尚未辨清，不能由常見姓氏認定種樹者。郵差種樹和躲雨動機皆缺獨立佐證，豆花攤現址也待確認。',
    sourceIds: ['seed-2', 'seed-3', 'scene-nextday-2'],
  },
  {
    title: '不同看法與下一步',
    text: '阿光質疑通訊來源，小葵亦保留判斷。可先找豆花攤與原通訊，再核照片日期、碑文，保留原說法與更正過程。',
    sourceIds: ['seed-2', 'seed-3', 'seed-6', 'scene-nextday-3'],
  },
];
const publicSourceIds = unique(sections.flatMap((section) => section.sourceIds));
export const PUBLIC_ARTICLES = freeze([{
  id: 'old-banyan-and-tofu',
  title: '老榕樹與豆花攤（虛構示範・待查）',
  body: sections.map((section) => `${section.title}：${section.text}`).join('\n\n'),
  sections, sourceIds: publicSourceIds,
  sources: publicSourceIds.map((sourceId) => SOURCE_CATALOG.find((source) => source.id === sourceId)),
  version: 1, scope: 'public-synthetic', verification: UNVERIFIED, synthetic: true,
  credit: '合成場景共創，人工整理',
  publicationStatus: 'public-read-only',
}]);

const sourceOK = (source) => source && typeof source.id === 'string' && typeof source.text === 'string'
  && typeof source.author === 'string' && ['user', 'script'].includes(source.origin)
  && (source.createdAt === null || dateOK(source.createdAt));
const revisionOK = (revision, index) => revision && typeof revision.id === 'string'
  && revision.number === index + 1 && typeof revision.title === 'string' && typeof revision.body === 'string'
  && strings(revision.sourceIds) && Array.isArray(revision.sources) && revision.sources.every(sourceOK)
  && typeof revision.note === 'string' && dateOK(revision.createdAt)
  && revision.scope === LOCAL && revision.verification === UNVERIFIED;
function validWiki(wiki) {
  if (!wiki || wiki.version !== 1 || !dateOK(wiki.updatedAt) || !Array.isArray(wiki.clips) || !Array.isArray(wiki.proposals)) return false;
  if (!wiki.clips.every((clip) => clip && typeof clip.id === 'string' && sourceOK(clip.source)
    && dateOK(clip.createdAt) && clip.scope === LOCAL && clip.verification === UNVERIFIED)) return false;
  if (!wiki.proposals.every((proposal) => proposal && typeof proposal.id === 'string'
    && proposal.scope === LOCAL && proposal.verification === UNVERIFIED
    && dateOK(proposal.createdAt) && dateOK(proposal.updatedAt)
    && strings(proposal.sourceClipIds) && Array.isArray(proposal.originalSources) && proposal.originalSources.every(sourceOK)
    && proposal.draft && typeof proposal.draft.title === 'string' && typeof proposal.draft.body === 'string'
    && strings(proposal.draft.sourceIds) && dateOK(proposal.draft.updatedAt)
    && Array.isArray(proposal.revisions) && proposal.revisions.length > 0 && proposal.revisions.every(revisionOK)
    && Array.isArray(proposal.dissent) && proposal.dissent.every((note) => note && typeof note.id === 'string'
      && typeof note.text === 'string' && strings(note.sourceIds) && Array.isArray(note.sources)
      && note.sources.every(sourceOK) && dateOK(note.createdAt) && note.scope === LOCAL
      && note.verification === UNVERIFIED))) return false;
  const ids = [...wiki.clips, ...wiki.proposals].map((item) => item.id);
  return ids.length === new Set(ids).size;
}

function setError(state, message) {
  Object.defineProperty(state, 'wikiError', { value: message, enumerable: false, configurable: true, writable: true });
}

/** Missing Wiki data is added; an unreadable existing Wiki is never replaced. */
export function ensureWiki(state) {
  if (!state || typeof state !== 'object') return null;
  if (!Object.hasOwn(state, 'wiki')) {
    state.wiki = { version: 1, clips: [], proposals: [], updatedAt: now() };
  }
  if (!validWiki(state.wiki)) {
    setError(state, '本機 Wiki 紀錄無法讀取，原內容未被替換。聊天仍可使用；請先匯出整份本機備份。');
    return null;
  }
  if (state.wikiError) delete state.wikiError;
  // Keep captured history immutable even after JSON restoration.
  for (const clip of state.wiki.clips) freeze(clip);
  for (const proposal of state.wiki.proposals) {
    proposal.originalSources.forEach(freeze);
    proposal.revisions.forEach(freeze);
    proposal.dissent.forEach(freeze);
  }
  return state.wiki;
}

function touch(state, proposal = null) {
  const at = now(); state.wiki.updatedAt = at;
  if (proposal) proposal.updatedAt = at;
}

function snapshot(message) {
  return freeze({
    id: message.id, messageId: message.id,
    author: typeof message.author === 'string' ? message.author : '未標示', text: message.text,
    origin: message.origin === 'script' ? 'script' : 'user',
    status: ['confirmed', 'pending', 'unknown'].includes(message.status) ? message.status : 'unknown',
    createdAt: dateOK(message.createdAt) ? message.createdAt : null, capturedAt: now(),
    sourceKind: message.origin === 'script' ? 'synthetic-dialogue' : 'local-dialogue',
    scope: LOCAL, verification: UNVERIFIED,
  });
}

/** No title/category is needed. Repeated retention reuses the exact original clip. */
export function retainExcerpt(state, messageOrId) {
  const wiki = ensureWiki(state); if (!wiki) return null;
  const message = typeof messageOrId === 'string' ? state.messages?.find((item) => item.id === messageOrId) : messageOrId;
  if (!message || typeof message.id !== 'string' || typeof message.text !== 'string') return null;
  const found = wiki.clips.find((clip) => clip.source.id === message.id && clip.source.text === message.text
    && clip.source.author === message.author && clip.source.origin === message.origin);
  if (found) return found;
  const clip = freeze({ id: id('wiki-clip'), source: snapshot(message), createdAt: now(), scope: LOCAL, verification: UNVERIFIED });
  wiki.clips.push(clip); touch(state); return clip;
}

function proposalById(state, proposalId) {
  return ensureWiki(state)?.proposals.find((proposal) => proposal.id === proposalId) ?? null;
}

function sourceFor(state, sourceId, proposal = null) {
  return proposal?.originalSources.find((source) => source.id === sourceId)
    ?? state.wiki.clips.find((clip) => clip.id === sourceId || clip.source.id === sourceId)?.source
    ?? SOURCE_CATALOG.find((source) => source.id === sourceId)
    ?? (() => { const message = state.messages?.find((item) => item.id === sourceId); return message ? snapshot(message) : null; })();
}

function sourcesFor(state, sourceIds, proposal = null) {
  return unique(sourceIds).map((sourceId) => sourceFor(state, sourceId, proposal)).filter(Boolean).map((source) => copy(source));
}

/** A local proposal always keeps a first version of its starting point. */
export function createProposal(state, options = {}) {
  const wiki = ensureWiki(state); if (!wiki) return null;
  const article = PUBLIC_ARTICLES.find((item) => item.id === options.publicArticleId);
  if (options.publicArticleId && !article) return null;
  const clip = wiki.clips.find((item) => item.id === options.clipId);
  if (options.clipId && !clip) return null;
  const sourceIds = unique([...(article?.sourceIds ?? []), ...(clip ? [clip.source.id] : [])]);
  // A message ID can have multiple retained snapshots. Start from the selected
  // clip (or the public article's own sources), never the first global ID match.
  const originalSources = sourceIds.map((sourceId) => copy(
    clip?.source.id === sourceId ? clip.source : article.sources.find((source) => source.id === sourceId),
  ));
  const at = now();
  const proposal = {
    id: id('wiki-proposal'), publicArticleId: article?.id ?? null,
    basedOnPublicVersion: article?.version ?? null,
    sourceClipIds: clip ? [clip.id] : [], originalSources,
    draft: {
      title: String(options.title ?? article?.title ?? ''),
      body: String(options.body ?? article?.body ?? clip?.source.text ?? ''),
      sourceIds, updatedAt: at,
    },
    revisions: [], dissent: [], createdAt: at, updatedAt: at,
    scope: LOCAL, verification: UNVERIFIED, publicationStatus: 'not-published',
  };
  proposal.originalSources.forEach(freeze);
  proposal.revisions.push(freeze({
    id: id('wiki-revision'), number: 1,
    title: proposal.draft.title, body: proposal.draft.body,
    sourceIds: [...sourceIds], sources: copy(proposal.originalSources),
    note: article ? '保留公共示範原版作為修訂起點' : clip ? '保留對話原話作為整理起點' : '本機草稿起點',
    createdAt: at, scope: LOCAL, verification: UNVERIFIED,
  }));
  wiki.proposals.push(proposal); touch(state); return proposal;
}

/** Autosave the editor separately: editing never mutates a saved revision. */
export function setProposalDraft(state, proposalId, patch = {}) {
  const proposal = proposalById(state, proposalId); if (!proposal) return null;
  const sourceIds = patch.sourceIds === undefined ? proposal.draft.sourceIds
    : unique(Array.isArray(patch.sourceIds) ? patch.sourceIds.filter((item) => typeof item === 'string' && sourceFor(state, item, proposal)) : []);
  proposal.draft = {
    title: String(patch.title ?? proposal.draft.title), body: String(patch.body ?? proposal.draft.body),
    sourceIds: [...sourceIds], updatedAt: now(),
  };
  touch(state, proposal); return proposal.draft;
}

export function saveRevision(state, proposalId, options = {}) {
  const proposal = proposalById(state, proposalId); if (!proposal) return null;
  const sources = sourcesFor(state, proposal.draft.sourceIds, proposal);
  for (const source of sources) {
    if (!proposal.originalSources.some((item) => item.id === source.id && item.text === source.text)) proposal.originalSources.push(freeze(copy(source)));
  }
  const revision = freeze({
    id: id('wiki-revision'), number: proposal.revisions.length + 1,
    title: proposal.draft.title, body: proposal.draft.body, sourceIds: [...proposal.draft.sourceIds], sources,
    note: String(options.note ?? ''), createdAt: now(), scope: LOCAL, verification: UNVERIFIED,
  });
  proposal.revisions.push(revision); touch(state, proposal); return revision;
}

export function addDissent(state, proposalId, text, options = {}) {
  const proposal = proposalById(state, proposalId); if (!proposal || !String(text ?? '').trim()) return null;
  if (options.revisionId && !proposal.revisions.some((revision) => revision.id === options.revisionId)) return null;
  const requestedSources = Array.isArray(options.sourceIds) ? options.sourceIds : [];
  const sourceIds = unique(requestedSources.filter((item) => typeof item === 'string' && sourceFor(state, item, proposal)));
  const note = freeze({
    id: id('wiki-dissent'), text: String(text), revisionId: options.revisionId ?? proposal.revisions.at(-1).id,
    sourceIds, sources: sourcesFor(state, sourceIds, proposal),
    createdAt: now(), scope: LOCAL, verification: UNVERIFIED,
  });
  proposal.dissent.push(note); touch(state, proposal); return note;
}

function lineDiff(left, right) {
  const a = left.split('\n'), b = right.split('\n');
  let prefix = 0; while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0; while (suffix < a.length - prefix && suffix < b.length - prefix && a.at(-suffix - 1) === b.at(-suffix - 1)) suffix += 1;
  const rows = a.length - prefix - suffix, columns = b.length - prefix - suffix;
  const result = a.slice(0, prefix).map((text, index) => ({ type: 'same', text, leftLine: index + 1, rightLine: index + 1 }));
  let i = prefix, j = prefix;
  if (rows * columns <= 250_000) {
    const table = Array.from({ length: rows + 1 }, () => new Uint32Array(columns + 1));
    for (let x = rows - 1; x >= 0; x -= 1) for (let y = columns - 1; y >= 0; y -= 1) {
      table[x][y] = a[prefix + x] === b[prefix + y] ? table[x + 1][y + 1] + 1 : Math.max(table[x + 1][y], table[x][y + 1]);
    }
    while (i < a.length - suffix || j < b.length - suffix) {
      if (i < a.length - suffix && j < b.length - suffix && a[i] === b[j]) {
        result.push({ type: 'same', text: a[i], leftLine: ++i, rightLine: ++j });
      } else if (i < a.length - suffix && (j >= b.length - suffix || table[i - prefix + 1][j - prefix] >= table[i - prefix][j - prefix + 1])) {
        result.push({ type: 'removed', text: a[i], leftLine: ++i, rightLine: null });
      } else result.push({ type: 'added', text: b[j], leftLine: null, rightLine: ++j });
    }
  } else {
    // Bounded memory for large pastes: exact prefix/suffix, explicit middle replacement.
    while (i < a.length - suffix) result.push({ type: 'removed', text: a[i], leftLine: ++i, rightLine: null });
    while (j < b.length - suffix) result.push({ type: 'added', text: b[j], leftLine: null, rightLine: ++j });
  }
  for (let n = suffix; n > 0; n -= 1) result.push({ type: 'same', text: a[a.length - n], leftLine: a.length - n + 1, rightLine: b.length - n + 1 });
  return result;
}

export function compareRevisions(state, proposalId, leftId, rightId) {
  const proposal = proposalById(state, proposalId); if (!proposal) return null;
  const find = (value, fallback) => value === undefined ? fallback : proposal.revisions.find((revision) => revision.id === value || revision.number === value);
  const left = find(leftId, proposal.revisions[0]), right = find(rightId, proposal.revisions.at(-1));
  if (!left || !right) return null;
  return { left, right, titleChanged: left.title !== right.title, lines: lineDiff(left.body, right.body), sourceIdsChanged: JSON.stringify(left.sourceIds) !== JSON.stringify(right.sourceIds) };
}

const normalize = (text) => String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
const matches = (text, tokens) => tokens.every((token) => normalize(text).includes(token));
const snippet = (text) => text.length > 180 ? `${text.slice(0, 180)}…` : text;

/** Searches original excerpts, historical revisions, and dissent; no categorization. */
export function searchWiki(state, query = '') {
  const tokens = normalize(query).split(' ').filter(Boolean);
  const hits = PUBLIC_ARTICLES.filter((article) => matches(`${article.title}\n${article.body}\n${article.sources.map((source) => source.text).join('\n')}`, tokens)).map((article) => ({
    type: 'public-article', id: article.id, title: article.title, text: snippet(article.body), scope: article.scope, verification: article.verification,
  }));
  const wiki = ensureWiki(state); if (!wiki) return hits;
  for (const proposal of [...wiki.proposals].reverse()) {
    // Search each record on its own. A dissent term must not also manufacture
    // an indistinguishable parent-proposal hit from an aggregated text field.
    if (matches(`${proposal.draft.title}\n${proposal.draft.body}`, tokens)) hits.push({
      type: 'proposal', id: proposal.id, title: proposal.draft.title, text: snippet(proposal.draft.body),
      label: '本機編輯草稿', scope: LOCAL, verification: UNVERIFIED,
    });
    for (const revision of proposal.revisions) {
      const sameAsDraft = revision.title === proposal.draft.title && revision.body === proposal.draft.body;
      if (!sameAsDraft && matches(`${revision.title}\n${revision.body}`, tokens)) hits.push({
        type: 'revision', id: revision.id, proposalId: proposal.id, revisionId: revision.id,
        revisionNumber: revision.number, title: revision.title, text: snippet(revision.body),
        label: `本機修訂 · 第${revision.number}版`, scope: LOCAL, verification: UNVERIFIED,
      });
    }
    for (const note of proposal.dissent) if (matches(note.text, tokens)) hits.push({
      type: 'dissent', id: note.id, proposalId: proposal.id, revisionId: note.revisionId,
      revisionNumber: proposal.revisions.find((revision) => revision.id === note.revisionId)?.number ?? null,
      title: proposal.draft.title, text: snippet(note.text), label: '本機異見', scope: LOCAL, verification: UNVERIFIED,
    });
  }
  for (const clip of [...wiki.clips].reverse()) if (matches(`${clip.source.author}\n${clip.source.text}`, tokens)) hits.push({
    type: 'clip', id: clip.id, title: '', text: snippet(clip.source.text), sourceId: clip.source.id, scope: LOCAL, verification: UNVERIFIED,
  });
  return hits;
}

export function exportProposal(state, proposalId) {
  const proposal = proposalById(state, proposalId); if (!proposal) return null;
  return {
    schema: 'liubai-wiki-proposal', schemaVersion: 1,
    createdBy: 'anonymous-local-visitor', exportedAt: new Date().toISOString(),
    scope: LOCAL, verification: UNVERIFIED, publicationStatus: 'not-published',
    explanation: '本機修訂提案，尚未公開或被證實；原話、各次修訂與異見一併保留。',
    proposal: copy(proposal),
    originalClips: copy(state.wiki.clips.filter((clip) => proposal.sourceClipIds.includes(clip.id))),
    basedOnPublicArticle: copy(PUBLIC_ARTICLES.find((article) => article.id === proposal.publicArticleId) ?? null),
  };
}
