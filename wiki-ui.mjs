import {
  PUBLIC_ARTICLES, SOURCE_CATALOG, ensureWiki, retainExcerpt, createProposal,
  setProposalDraft, saveRevision, addDissent, compareRevisions, searchWiki, exportProposal,
} from './wiki-core.mjs';

const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (text, n = 95) => text.length > n ? text.slice(0, n) + '…' : text;
const time = (value) => new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(value);
const button = (action, text, id = '', cls = 'text-button') => `<button class="${cls}" data-wiki-action="${action}" data-id="${escape(id)}">${text}</button>`;
const isCuratedArticle = (article) => article?.scope === 'public-curated' && article.synthetic === false;
const isCuratedSource = (source) => source?.origin === 'curated' && source.scope === 'public-curated' && source.synthetic === false && source.verification === 'unverified' && source.sourceKind === 'project-collaboration-summary' && typeof source.contextId === 'string' && source.contextId.length > 0;
const articleNavTitle = (article) => article.id === 'old-banyan-and-tofu' ? '老榕樹與豆花攤' : article.id === 'base-how-we-gather' ? '基地怎麼相處' : article.title;
const publicLabel = (article) => isCuratedArticle(article) ? '本專案共創草案 · 未定稿' : '公共合成示範 · 待查';
const sourceLabel = (source, snapshot = false) => isCuratedSource(source) ? '公共共創過程整理' : source.origin === 'script' ? '合成場景原話' : snapshot ? '本人自寫 · 本機快照' : '本人自寫 · 本機原話';

export function initWikiUI({ getState, persist, notify, onOpen, onSource, onPocket, getSaveError }) {
  const root = document.querySelector('#wiki-view');
  let selected = { type: 'public', id: PUBLIC_ARTICLES[0].id };
  let query = '';
  let returnQuery = '';
  let publicArticles = PUBLIC_ARTICLES;
  let sourceCatalog = SOURCE_CATALOG;
  let publicLoadStarted = false;
  let publicStatus = '內附公共快照 · 開啟時確認共享來源';
  let publicPhase = 'snapshot';
  let sourceReturnFocus = null;
  const $ = (selector) => root.querySelector(selector);
  const wiki = () => ensureWiki(getState());
  const proposal = () => wiki()?.proposals.find((item) => item.id === selected.id);
  const save = () => { const ok = persist(); updateSaveHint(); return ok; };
  root.innerHTML = `<div class="wiki-top"><div class="wiki-topline"><div><span class="wiki-eyebrow">共同 Wiki · 從原話開始</span><h2>把線索，慢慢整理。</h2><p>保留原話、異見與修訂；留下不代表已證實。</p></div><span class="wiki-public-status">公共頁只讀 · 私人草稿僅本機</span></div><p id="wiki-public-store" class="wiki-store-status" role="status" aria-atomic="true" data-state="snapshot"></p><div class="wiki-search-wrap"><label for="wiki-search">找回線索</label><input id="wiki-search" type="search" placeholder="搜尋原話、草稿、舊版本或異見" maxlength="200" autocomplete="off"></div><p class="wiki-search-hint">搜尋公共原版與自己的本機內容；不含他人私稿。</p></div><div class="wiki-layout"><aside class="wiki-rail" aria-label="知識頁與本機草稿"></aside><div class="wiki-content"></div></div>`;
  const dialog = document.createElement('dialog');
  dialog.id = 'wiki-source-dialog'; dialog.className = 'wiki-source-dialog';
  dialog.setAttribute('aria-label', '對話原文與來源'); document.body.append(dialog);

  function focusDescription(element) {
    if (!element || !root.contains(element)) return null;
    if (element.id) return { selector: `#${CSS.escape(element.id)}` };
    const action = element.closest('button[data-wiki-action]');
    if (action) return { selector: `[data-wiki-action="${CSS.escape(action.dataset.wikiAction)}"][data-id="${CSS.escape(action.dataset.id || '')}"]` };
    if (element.classList.contains('wiki-article-title')) return { selector: '.wiki-content .wiki-article-title' };
    return null;
  }

  function restoreFocus(description) {
    if (!description) return;
    root.querySelector(description.selector)?.focus({ preventScroll: true });
  }

  function setPublicStatus() {
    const element = $('#wiki-public-store');
    element.textContent = publicStatus;
    element.dataset.state = publicPhase;
  }

  dialog.addEventListener('close', () => {
    if (!root.hidden) restoreFocus(sourceReturnFocus);
    sourceReturnFocus = null;
  });

  function renderRail() {
    const data = wiki();
    const focused = $('.wiki-rail').contains(document.activeElement) ? focusDescription(document.activeElement) : null;
    const wasOpen = $('.wiki-local-nav')?.open ?? !matchMedia('(max-width: 760px)').matches;
    const isCurrent = (type, id = '') => selected.type === type && (!id || selected.id === id) && !query.trim();
    $('.wiki-rail').innerHTML = `<section class="wiki-public-nav" aria-labelledby="wiki-public-heading"><h3 id="wiki-public-heading" class="wiki-rail-heading">公開知識 · 所有人同一原版</h3>${publicArticles.map((article) => `<button class="wiki-choice ${isCurrent('public', article.id) ? 'active' : ''}" ${isCurrent('public', article.id) ? 'aria-current="page"' : ''} aria-label="${escape(article.title)}" data-wiki-action="public" data-id="${escape(article.id)}">${escape(articleNavTitle(article))}<small>${isCuratedArticle(article) ? '共創草案 · 未定稿' : '虛構示範 · 待查'}</small></button>`).join('')}</section><details class="wiki-local-nav" ${wasOpen ? 'open' : ''}><summary><span>我的本機草稿</span><small>僅這個瀏覽器 · 未發布</small></summary><div class="wiki-local-links">${data?.proposals.length ? [...data.proposals].reverse().map((item) => `<button class="wiki-choice ${isCurrent('proposal', item.id) ? 'active' : ''}" ${isCurrent('proposal', item.id) ? 'aria-current="page"' : ''} data-wiki-action="proposal" data-id="${escape(item.id)}">${escape(item.draft.title || '未命名草稿')}<small>${item.revisions.length} 版 · ${item.dissent.length} 則不同看法</small></button>`).join('') : '<p class="wiki-rail-empty">先留原話也可以，<br>不必現在命名或分類。</p>'}${button('new', '＋ 空白本機草稿', '', 'wiki-new')}<button class="wiki-choice ${isCurrent('clips') ? 'active' : ''}" ${isCurrent('clips') ? 'aria-current="page"' : ''} data-wiki-action="clips" data-id="">口袋原話<small>保留不代表已證實</small></button></div></details><div class="wiki-help"><strong>怎樣真的貢獻？</strong>在瀏覽器整理提案、留好版本與異見，再匯出檔案交給受信任的整理者。審閱後才能發布原站。<br><br>目前沒有共享寫入或同步。</div><button class="wiki-help-link" ${isCurrent('contribute') ? 'aria-current="page"' : ''} data-wiki-action="contribute" data-id="">貢獻方式 →</button>`;
    restoreFocus(focused);
  }

  function sourceById(id) {
    const data = wiki();
    if (selected.type === 'public') return publicArticles.find((article) => article.id === selected.id)?.sources.find((source) => source.id === id) ?? sourceCatalog.find((source) => source.id === id);
    return proposal()?.originalSources.find((source) => source.id === id)
      ?? data?.clips.find((clip) => clip.source.id === id)?.source
      ?? sourceCatalog.find((source) => source.id === id);
  }

  function sourcesMarkup(sources) {
    const curated = sources.length > 0 && sources.every(isCuratedSource);
    return `<section class="wiki-source-section"><h3 class="wiki-section-heading">${curated ? '共創過程與來源' : '原話與來源'}</h3><p class="wiki-small">${curated ? '以下是本專案公共共創過程的整理，並非私人對話逐字稿、模型親歷記憶或供應商官方聲明。' : '保留原句，不把轉述當作外部證據。點擊可回到對話或查看合成原文脈絡。'}</p><div class="wiki-source-list">${sources.map((source) => `<button class="wiki-source" data-wiki-action="source" data-id="${escape(source.id)}"><strong>${escape(source.author)} · ${sourceLabel(source)}</strong><span>${escape(short(source.text, 160))}</span><small>${isCuratedSource(source) ? '查看共創過程 ↗' : '回到原話 ↗'}${source.status === 'unknown' ? ' · 這則的本機送出結果仍未知' : ''}</small></button>`).join('')}</div></section>`;
  }

  function renderPublic(article) {
    const curated = isCuratedArticle(article);
    return `<article class="wiki-page wiki-public-article" data-public-id="${escape(article.id)}"><div class="wiki-tags"><span class="wiki-tag">公開原版 · 只讀</span><span class="wiki-tag unverified">${curated ? '本專案共創草案 · 未定稿' : '虛構示範 · 待查'}</span></div><h2 class="wiki-article-title">${escape(article.title)}</h2><p class="wiki-credit">${escape(article.credit)} · 公共原版第 ${article.version} 版</p><div class="wiki-notice">${curated ? '這是本專案的協作設計草案，不代表外部事實已核實，也不是即時模型對話或供應商官方政策。你的私人草稿不會出現在這個公共原版。' : '這是虛構場景的人工整理，並非外部已核實事實，也不是 Muse／Gemini 的即時回覆。你的私人草稿不會出現在這個公共原版。'}</div><div class="wiki-body">${article.sections.map((section) => `<section><h3>${escape(section.title)}</h3>${(curated ? section.text.split(/\n\n/) : [section.text]).map((paragraph) => `<p>${escape(paragraph)}</p>`).join('')}</section>`).join('')}</div><div class="wiki-actions">${button('propose', '提出本機修訂 →', article.id, 'primary-small')}${button('contribute', '怎樣把提案交給整理者？')}</div>${sourcesMarkup(article.sources)}${article.footer ? `<footer class="wiki-article-footer"><p>${escape(article.footer)}</p></footer>` : ''}</article>`;
  }

  function renderProposal(item) {
    const revisions = item.revisions;
    return `<article class="wiki-page wiki-private-proposal" data-proposal-id="${escape(item.id)}"><div class="wiki-tags"><span class="wiki-tag private">私人本機草稿 · 未發布</span><span class="wiki-tag unverified">尚未核實</span></div><h2 class="wiki-article-title">把這段，慢慢整理。</h2><div class="wiki-notice private">只有這個瀏覽器能看見這份草稿。留版與匯出都不會更新公共原版，也不會傳給其他訪客。</div><div class="wiki-field"><label for="wiki-draft-title">標題（可以先空著）</label><input id="wiki-draft-title" maxlength="200" value="${escape(item.draft.title)}" placeholder="還沒命名也沒關係"></div><div class="wiki-field"><label for="wiki-draft-body">你的整理與保留的疑問</label><textarea id="wiki-draft-body" rows="10" maxlength="60000" placeholder="先留原話，慢慢補上脈絡、來源與不同看法。">${escape(item.draft.body)}</textarea></div><p id="wiki-save-state" class="wiki-draft-state" role="status"></p><div class="wiki-version-bar"><div class="wiki-field"><label for="wiki-revision-note">這次改了什麼（可留空）</label><input id="wiki-revision-note" maxlength="500" value="${escape(item.pendingRevisionNote || '')}" placeholder="例如：保留動機未有佐證這一點"></div>${button('save', '留一版在本機', item.id, 'primary-small')}</div><div class="wiki-actions">${button('export', '匯出提案（含原話、全部版本與異見）', item.id)}${item.publicArticleId ? button('public', '回看公共原版 ↗', item.publicArticleId) : ''}</div><p class="wiki-small wiki-export-note">匯出會包含這份提案的原話、全部舊版與異見；分享前請檢查。</p><details class="wiki-revisions"><summary>修訂紀錄與比較（${revisions.length} 版）</summary><p class="wiki-small">編輯區會自動保存草稿；按「留一版」才新增版本。舊版本與最初原話不會被覆蓋。</p><div class="wiki-history">${revisions.map((revision) => `<div class="wiki-history-item" data-revision-id="${escape(revision.id)}"><strong>第 ${revision.number} 版 · ${escape(revision.title || '未命名')}</strong><p>${escape(revision.note || '未附版本說明')}</p><small>${time(revision.createdAt)} · 本機未發布</small><details><summary>讀取這一版原文</summary><p>${escape(revision.body).replace(/\n/g, '<br>')}</p></details></div>`).join('')}</div><div class="wiki-compare-controls"><label for="wiki-compare-left">比較</label><select id="wiki-compare-left">${revisions.map((revision) => `<option value="${escape(revision.id)}">第 ${revision.number} 版</option>`).join('')}</select><span>與</span><select id="wiki-compare-right">${revisions.map((revision, index) => `<option value="${escape(revision.id)}" ${index === revisions.length - 1 ? 'selected' : ''}>第 ${revision.number} 版</option>`).join('')}</select>${button('compare', '顯示差異', item.id, 'quiet-button')}</div><div id="wiki-diff-result"></div></details><details class="wiki-dissent-panel"><summary>不同看法與待查問題（${item.dissent.length}）</summary><p class="wiki-small">可以保留質疑，不必把所有說法湊成一個答案。這些意見也只在本機。</p>${item.dissent.map((note) => `<div class="wiki-dissent-item" data-dissent-id="${escape(note.id)}"><p>${escape(note.text)}</p><small>${time(note.createdAt)} · 第 ${revisions.find((revision) => revision.id === note.revisionId)?.number ?? '—'} 版旁的本機異見 · 未核實</small></div>`).join('')}<div class="wiki-field"><label for="wiki-dissent-text">補一個不同看法</label><textarea id="wiki-dissent-text" rows="3" maxlength="4000" placeholder="哪裡值得再查？也可以保留另一種解釋。">${escape(item.pendingDissent || '')}</textarea></div>${button('dissent', '把這個看法留在本機', item.id, 'quiet-button')}</details>${sourcesMarkup(item.originalSources)}</article>`;
  }

  function renderClips() {
    const data = wiki();
    return `<article class="wiki-page"><div class="wiki-tags"><span class="wiki-tag private">同一份口袋筆記 · 僅本機</span><span class="wiki-tag unverified">保留不代表已證實</span></div><h2 class="wiki-article-title">先留原話，晚點整理。</h2><p class="wiki-small">來自對話裡的「留這段」或原有稍後回看。不強迫命名、分類，也不自動做摘要。</p>${data?.clips.length ? [...data.clips].reverse().map((clip) => `<section class="wiki-clip" data-clip-id="${escape(clip.id)}"><span class="wiki-tag private">${escape(clip.source.author)} · ${clip.source.origin === 'script' ? '示範腳本原話' : '本人自寫原話'}</span><blockquote>${escape(clip.source.text)}</blockquote><div class="wiki-actions">${button('from-clip', '整理成一份本機草稿 →', clip.id)}${button('clip-source', '回到原話 ↗', clip.id)}</div></section>`).join('') : `<p class="wiki-empty">目前還沒有原話。<br>回到對話，輕輕留一段就好。</p>${button('chat', '回到對話 →', '', 'primary-small')}`}</article>`;
  }

  function renderSearch() {
    const hits = searchWiki(getState(), query);
    return `<section class="wiki-search-results"><h2 class="wiki-section-heading">找到 ${hits.length} 個線頭</h2><p class="wiki-small">包括舊版本與異見；搜尋結果不是核實結果。</p>${hits.length ? hits.map((hit) => `<button class="wiki-result" data-wiki-action="result" data-id="${escape(hit.id)}" data-kind="${escape(hit.type)}" data-proposal="${escape(hit.proposalId || '')}"><small>${hit.type === 'public-article' ? publicLabel(publicArticles.find((article) => article.id === hit.id)) : hit.type === 'dissent' ? '本機異見 · 未發布' : hit.type === 'revision' ? `本機歷史 · 第 ${escape(hit.revisionNumber)} 版 · 未發布` : hit.type === 'proposal' ? '本機目前草稿 · 未發布' : '本機原話 · 未發布'}</small><strong>${escape(hit.title || (hit.type === 'clip' ? '口袋裡的原話' : '未命名草稿'))}</strong><p>${escape(hit.text)}</p></button>`).join('') : '<p class="wiki-empty">沒有找到。可以試試原句中的另一個詞。</p>'}</section>`;
  }

  function contributionMarkup() {
    return `<article class="wiki-page"><div class="wiki-tags"><span class="wiki-tag">正常瀏覽器即可參與整理</span></div><h2 class="wiki-article-title">讓提案帶著來源，一起走。</h2><div class="wiki-notice">目前沒有共享寫入：這個網站不接收或自動發布你的草稿。公共原版由受信任的整理者審閱、更新同一站點。</div><ol class="wiki-contribution-steps"><li>在公共頁點「提出本機修訂」，或從口袋原話開始，不必先命名分類。</li><li>整理文字、留版本，把異見與待查處一起留下。</li><li>按「匯出提案」，把包含原話和全部版本的 JSON 檔，透過你選擇的可信管道交給整理者。請先確認你願意分享其中的個人內容。</li><li>整理者審閱來源、異見與修訂後，再發布到這個原站。收到檔案不等於採納，存下也不等於已核實。</li></ol><p class="wiki-small">真正的跨瀏覽器提交與審核佇列，要等免費儲存、存取隔離與濫用限制確認後才啟用。沒有匿名改寫或刪除全站的入口。</p>${button('public', '讀讀第一篇 →', PUBLIC_ARTICLES[0].id, 'primary-small')}</article>`;
  }

  function renderContent() {
    const data = wiki();
    const error = getState().wikiError;
    let html = '';
    if (query.trim()) html = renderSearch();
    else if (selected.type === 'clips') html = renderClips();
    else if (selected.type === 'contribute') html = contributionMarkup();
    else if (selected.type === 'proposal' && proposal()) html = renderProposal(proposal());
    else { selected = { type: 'public', id: publicArticles.find((item) => item.id === selected.id)?.id ?? PUBLIC_ARTICLES[0].id }; html = renderPublic(publicArticles.find((item) => item.id === selected.id)); }
    $('.wiki-content').innerHTML = `${returnQuery && !query.trim() ? `<button class="wiki-search-return" data-wiki-action="search-back">← 返回「${escape(returnQuery)}」的搜尋結果</button>` : ''}${error ? `<p class="wiki-error" role="alert">${escape(error)}</p>` : ''}${html}`;
    if (!data) $('.wiki-content').querySelectorAll('[data-wiki-action="propose"],[data-wiki-action="new"]').forEach((element) => { element.disabled = true; });
    updateSaveHint();
  }

  async function loadPublic() {
    if (publicLoadStarted) return;
    publicLoadStarted = true;
    publicPhase = 'loading';
    publicStatus = '正在確認同站的公共知識來源…';
    setPublicStatus();
    try {
      const response = await fetch('/api/wiki', { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(6000) });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('unavailable');
      const reader = response.body.getReader(); const chunks = []; let length = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 65536) { await reader.cancel(); throw new Error('oversized'); } chunks.push(value); }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const data = JSON.parse(new TextDecoder().decode(bytes));
      // The curator publishes the approved source and database revision together.
      // A mismatching or malformed response cannot replace the reviewed snapshot.
      if (data.schema !== 'liubai-public-wiki' || data.schemaVersion !== 1 || data.source !== 'persistent-d1' || data.writes !== 'disabled' || JSON.stringify(data.articles) !== JSON.stringify(PUBLIC_ARTICLES) || JSON.stringify(data.sources) !== JSON.stringify(SOURCE_CATALOG) || !Array.isArray(data.revisions) || data.revisions.length !== PUBLIC_ARTICLES.length || data.revisions.some((revision, index) => revision.articleId !== PUBLIC_ARTICLES[index].id || revision.version !== PUBLIC_ARTICLES[index].version || !/^[a-f0-9]{64}$/.test(revision.contentHash) || revision.revisionId !== revision.contentHash)) throw new Error('mismatched');
      publicArticles = data.articles; sourceCatalog = data.sources;
      publicPhase = 'ready';
      publicStatus = '公共原版已從同站共享資料庫讀取 · 訪客寫入關閉';
    } catch {
      publicPhase = 'fallback';
      publicStatus = ['localhost', '127.0.0.1'].includes(location.hostname)
        ? '內附公共快照 · 本機模式，未確認共享資料庫'
        : '暫用內附公共快照 · 共享資料庫目前無法確認';
    }
    setPublicStatus();
    // Do not replace an active private editor while it is being typed into.
    if (selected.type === 'public' && !query.trim()) refresh();
  }

  function updateSaveHint() {
    const element = $('#wiki-save-state'); if (!element) return;
    const error = getSaveError();
    element.textContent = error ? '本機保存未成功，請保持此頁開啟並匯出備份。' : '編輯已留在本機草稿，尚未發布；公共原版不變。';
    element.classList.toggle('error', Boolean(error));
    element.dataset.state = error ? 'error' : 'saved';
  }

  function refresh({ keepFocus = true } = {}) {
    const focused = keepFocus ? focusDescription(document.activeElement) : null;
    setPublicStatus();
    if (selected.type === 'proposal' && !proposal()) selected = { type: 'public', id: PUBLIC_ARTICLES[0].id };
    renderRail(); renderContent();
    restoreFocus(focused);
  }

  function select(type, id = '', fromSearch = false, { editor = false } = {}) {
    returnQuery = fromSearch ? query : '';
    selected = { type, id }; query = ''; $('#wiki-search').value = '';
    refresh({ keepFocus: false }); root.scrollTo({ top: 0, behavior: 'instant' });
    // The DOM is already rendered. Finish focus in this action; a queued frame
    // could otherwise steal focus after someone starts typing in another field.
    const destination = editor ? $('#wiki-draft-title') : $('.wiki-content .wiki-article-title, .wiki-content h2');
    $('.wiki-content')?.scrollIntoView({ block: 'start', behavior: 'instant' });
    if (destination) { destination.tabIndex = destination.tagName === 'INPUT' ? 0 : -1; destination.focus({ preventScroll: true }); }
  }

  function openSource(source, trigger) {
    if (!source) return;
    const curated = isCuratedSource(source);
    if (source.origin !== 'curated' && onSource(source)) return;
    const isCanonical = sourceCatalog.some((item) => item.id === source.id && item.origin === source.origin && item.author === source.author && item.text === source.text && item.contextId === source.contextId && item.sourceKind === source.sourceKind && item.sceneId === source.sceneId);
    const context = !isCanonical ? [source] : curated
      ? sourceCatalog.filter((item) => isCuratedSource(item) && source.contextId && item.contextId === source.contextId)
      : sourceCatalog.filter((item) => item.origin === source.origin && item.sceneId === source.sceneId);
    const contextNote = curated
      ? isCanonical ? '這是本專案公共共創過程的整理，只呈現這一頁的來源說明，不是私人對話逐字稿、模型親歷記憶或即時回覆。' : '這是你在本機保留的公共共創過程整理快照，不會改動公共原版，也不代表說法已被核實。'
      : isCanonical ? '這是公開合成場景的完整原文脈絡。這段尚未出現在你的本機對話裡，因此在此讀原文，不會替你新增聊天。' : '這是你在本機留下的原話快照。原句保留，不代表說法已被核實。';
    sourceReturnFocus = focusDescription(trigger);
    dialog.setAttribute('aria-label', curated ? '公共共創過程與來源' : '對話原文與來源');
    dialog.innerHTML = `<h2>${curated ? '查看公共共創過程。' : '回到原話，而非推論。'}</h2><p>${contextNote}</p><div class="wiki-source-context">${context.map((item) => `<article class="${item.id === source.id ? 'selected' : ''}" data-source-ref="${escape(item.id)}"><strong>${escape(item.author)} · ${sourceLabel(item, true)}</strong><p>${escape(item.text)}</p></article>`).join('')}</div><div class="dialog-actions"><button class="primary-small" id="wiki-close-source">回到知識頁</button></div>`;
    dialog.showModal(); dialog.querySelector('#wiki-close-source').addEventListener('click', () => dialog.close());
    dialog.querySelector('.selected')?.scrollIntoView({ block: 'center' });
  }

  root.addEventListener('input', (event) => {
    if (event.target.id === 'wiki-search') { returnQuery = ''; query = event.target.value; renderRail(); renderContent(); return; }
    if (['wiki-draft-title', 'wiki-draft-body'].includes(event.target.id)) {
      const item = proposal(); if (!item) return;
      setProposalDraft(getState(), item.id, { title: $('#wiki-draft-title').value, body: $('#wiki-draft-body').value }); save(); renderRail();
    }
    if (['wiki-revision-note', 'wiki-dissent-text'].includes(event.target.id)) {
      const item = proposal(); if (!item) return;
      item[event.target.id === 'wiki-revision-note' ? 'pendingRevisionNote' : 'pendingDissent'] = event.target.value; save();
    }
  });

  root.addEventListener('click', (event) => {
    const target = event.target.closest('button[data-wiki-action]'); if (!target) return;
    const id = target.dataset.id;
    switch (target.dataset.wikiAction) {
      case 'public': select('public', id); break;
      case 'proposal': select('proposal', id); break;
      case 'clips': select('clips'); break;
      case 'contribute': select('contribute'); break;
      case 'chat': onOpen('chat'); break;
      case 'source': openSource(sourceById(id), target); break;
      case 'clip-source': openSource(wiki()?.clips.find((clip) => clip.id === id)?.source, target); break;
      case 'new': case 'propose': {
        const item = createProposal(getState(), target.dataset.wikiAction === 'propose' ? { publicArticleId: id } : {});
        if (!item) { notify('本機 Wiki 暫時無法寫入，原資料保留。'); break; }
        save(); select('proposal', item.id, false, { editor: true }); break;
      }
      case 'from-clip': {
        const item = createProposal(getState(), { clipId: id }); if (!item) break;
        save(); select('proposal', item.id, false, { editor: true }); break;
      }
      case 'save': {
        if (!saveRevision(getState(), id, { note: $('#wiki-revision-note').value })) break;
        proposal().pendingRevisionNote = ''; const saved = save(); refresh(); notify(saved ? '新版本已留在本機，舊版本與原話仍在。' : '這一版仍在此頁，尚未保存；請保持開啟並匯出。'); break;
      }
      case 'compare': {
        const difference = compareRevisions(getState(), id, $('#wiki-compare-left').value, $('#wiki-compare-right').value);
        if (!difference) break;
        $('#wiki-diff-result').innerHTML = `<p class="wiki-small">只比較文字，不替任何版本判定真假。${difference.titleChanged ? `<br>標題：${escape(difference.left.title || '未命名')} → ${escape(difference.right.title || '未命名')}` : ''}</p><div class="wiki-diff">${difference.lines.map((line) => `<div class="wiki-diff-line ${line.type}">${line.type === 'added' ? '＋ ' : line.type === 'removed' ? '－ ' : '　 '}${escape(line.text)}</div>`).join('')}</div>`;
        break;
      }
      case 'dissent': {
        const item = proposal();
        if (!addDissent(getState(), id, $('#wiki-dissent-text').value, { revisionId: item.revisions.at(-1).id, sourceIds: item.draft.sourceIds })) { notify('先寫下一點不同看法，再留下。'); break; }
        item.pendingDissent = ''; const saved = save(); refresh(); $('.wiki-dissent-panel').open = true; $('[data-wiki-action="dissent"]')?.focus({ preventScroll: true }); notify(saved ? '不同看法已留在本機，不會覆蓋原文。' : '這個看法仍在此頁，尚未保存；請保持開啟並匯出。'); break;
      }
      case 'export': {
        const payload = exportProposal(getState(), id); if (!payload) break;
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
        anchor.href = url; anchor.download = `留白Wiki-本機提案-${new Date().toISOString().slice(0, 10)}.json`; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000); notify('已匯出提案，尚未上傳或發布。'); break;
      }
      case 'search-back': {
        query = returnQuery; returnQuery = ''; $('#wiki-search').value = query;
        refresh(); root.scrollTo({ top: 0, behavior: 'instant' }); $('#wiki-search').focus(); break;
      }
      case 'result': {
        const kind = target.dataset.kind;
        if (kind === 'public-article') select('public', id, true);
        else if (kind === 'proposal') select('proposal', id, true);
        else if (kind === 'dissent' || kind === 'revision') {
          select('proposal', target.dataset.proposal, true);
          const panel = $(kind === 'dissent' ? '.wiki-dissent-panel' : '.wiki-revisions');
          if (panel) panel.open = true;
          const entry = root.querySelector(`[data-${kind === 'dissent' ? 'dissent' : 'revision'}-id="${CSS.escape(id)}"]`);
          if (kind === 'revision') entry?.querySelector('details')?.setAttribute('open', '');
          if (entry) { entry.classList.add('wiki-search-target'); entry.tabIndex = -1; entry.focus({ preventScroll: true }); entry.scrollIntoView({ block: 'center', behavior: 'instant' }); }
        } else {
          select('clips', '', true);
          const entry = root.querySelector(`[data-clip-id="${CSS.escape(id)}"]`); if (entry) { entry.classList.add('wiki-search-target'); entry.tabIndex = -1; entry.focus({ preventScroll: true }); entry.scrollIntoView({ block: 'center', behavior: 'instant' }); }
        }
        break;
      }
    }
  });

  refresh();
  return {
    refresh, loadPublic, updateSaveHint,
    resetView() { query = ''; returnQuery = '';  $('#wiki-search').value = ''; selected = { type: 'public', id: PUBLIC_ARTICLES[0].id }; if (dialog.open) dialog.close(); dialog.replaceChildren(); refresh(); },
    retain(message) { const clip = retainExcerpt(getState(), message); if (clip) save(); refresh(); return clip; },
    fromMessage(message) {
      const clip = retainExcerpt(getState(), message); if (!clip) { notify('Wiki 紀錄無法寫入，原話仍保留在對話。'); return; }
      const item = createProposal(getState(), { clipId: clip.id }); if (!item) return;
      save(); onOpen('wiki'); select('proposal', item.id, false, { editor: true });
    },
    openPocket() { onPocket(); },
  };
}
