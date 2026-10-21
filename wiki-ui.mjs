import {
  PUBLIC_ARTICLES, SOURCE_CATALOG, ensureWiki, retainExcerpt, createProposal,
  setProposalDraft, saveRevision, addDissent, compareRevisions, searchWiki, exportProposal,
} from './wiki-core.mjs';

const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (text, n = 95) => text.length > n ? text.slice(0, n) + '…' : text;
const time = (value) => new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(value);
const button = (action, text, id = '', cls = 'text-button') => `<button class="${cls}" data-wiki-action="${action}" data-id="${escape(id)}">${text}</button>`;

export function initWikiUI({ getState, persist, notify, onOpen, onSource, onPocket, getSaveError }) {
  const root = document.querySelector('#wiki-view');
  let selected = { type: 'public', id: PUBLIC_ARTICLES[0].id };
  let query = '';
  let returnQuery = '';
  let publicArticles = PUBLIC_ARTICLES;
  let sourceCatalog = SOURCE_CATALOG;
  let publicLoadStarted = false;
  let publicStatus = '內附公共快照 · 開啟時確認共享來源';
  const $ = (selector) => root.querySelector(selector);
  const wiki = () => ensureWiki(getState());
  const proposal = () => wiki()?.proposals.find((item) => item.id === selected.id);
  const save = () => { const ok = persist(); updateSaveHint(); return ok; };
  root.innerHTML = `<div class="wiki-top"><div class="wiki-topline"><div><span class="wiki-eyebrow">共同 Wiki · 從原話開始</span><h2>線索可以留下，答案慢慢長出來。</h2><p>保留來源、不同看法與修訂。存下來，不代表已證實。</p></div><span class="wiki-public-status">公共頁只讀 · 私人草稿僅本機</span></div><p id="wiki-public-store" class="wiki-store-status" role="status"></p><div class="wiki-search-wrap"><label for="wiki-search">找回線索</label><input id="wiki-search" type="search" placeholder="搜尋原話、草稿、舊版本或異見" maxlength="200" autocomplete="off"></div><p class="wiki-search-hint">搜尋公共示範與你自己的本機內容，不搜尋其他訪客的私聊。</p></div><div class="wiki-layout"><aside class="wiki-rail" aria-label="知識頁與本機草稿"></aside><div class="wiki-content"></div></div>`;
  const dialog = document.createElement('dialog');
  dialog.id = 'wiki-source-dialog'; dialog.className = 'wiki-source-dialog';
  dialog.setAttribute('aria-label', '對話原文與來源'); document.body.append(dialog);

  function renderRail() {
    const data = wiki();
    $('.wiki-rail').innerHTML = `<h3 class="wiki-rail-heading">公開知識 · 所有人同一原版</h3>${publicArticles.map((article) => `<button class="wiki-choice ${selected.type === 'public' && selected.id === article.id && !query ? 'active' : ''}" data-wiki-action="public" data-id="${escape(article.id)}">${escape(article.title)}<small>合成場景共創，人工整理 · 待查</small></button>`).join('')}<h3 class="wiki-rail-heading local-heading">我的本機草稿 · 未發布</h3>${data?.proposals.length ? [...data.proposals].reverse().map((item) => `<button class="wiki-choice ${selected.type === 'proposal' && selected.id === item.id && !query ? 'active' : ''}" data-wiki-action="proposal" data-id="${escape(item.id)}">${escape(item.draft.title || '未命名草稿')}<small>${item.revisions.length} 版 · ${item.dissent.length} 則不同看法</small></button>`).join('') : '<p class="wiki-rail-empty">先留原話也可以，<br>不必現在命名或分類。</p>'}${button('new', '＋ 空白本機草稿', '', 'wiki-new')}${button('clips', `口袋原話（${data?.clips.length ?? 0}）`, '', `wiki-choice ${selected.type === 'clips' ? 'active' : ''}`)}<div class="wiki-help"><strong>怎樣真的貢獻？</strong>在瀏覽器整理提案、留好版本與異見，再匯出檔案交給受信任的整理者。審閱後才能發布原站。<br><br>目前沒有共享寫入或同步。${button('contribute', '看看貢獻方式 →')}</div>`;
  }

  function sourceById(id) {
    const data = wiki();
    if (selected.type === 'public') return publicArticles.find((article) => article.id === selected.id)?.sources.find((source) => source.id === id) ?? sourceCatalog.find((source) => source.id === id);
    return proposal()?.originalSources.find((source) => source.id === id)
      ?? data?.clips.find((clip) => clip.source.id === id)?.source
      ?? sourceCatalog.find((source) => source.id === id);
  }

  function sourcesMarkup(sources) {
    return `<section class="wiki-source-section"><h3 class="wiki-section-heading">原話與來源</h3><p class="wiki-small">保留原句，不把轉述當作外部證據。點擊可回到對話或查看合成原文脈絡。</p><div class="wiki-source-list">${sources.map((source) => `<button class="wiki-source" data-wiki-action="source" data-id="${escape(source.id)}"><strong>${escape(source.author)} · ${source.origin === 'script' ? '合成場景原話' : '本人自寫 · 本機原話'}</strong><span>${escape(short(source.text, 160))}</span><small>回到原話 ↗${source.status === 'unknown' ? ' · 這則的本機送出結果仍未知' : ''}</small></button>`).join('')}</div></section>`;
  }

  function renderPublic(article) {
    return `<article class="wiki-page wiki-public-article" data-public-id="${escape(article.id)}"><div class="wiki-tags"><span class="wiki-tag">公開原版 · 只讀</span><span class="wiki-tag unverified">虛構示範 · 待查</span></div><h2 class="wiki-article-title">${escape(article.title)}</h2><p class="wiki-credit">${escape(article.credit)} · 公共原版第 ${article.version} 版</p><div class="wiki-notice">這是虛構場景的人工整理，並非外部已核實事實，也不是 Muse／Gemini 的即時回覆。你的私人草稿不會出現在這個公共原版。</div><div class="wiki-body">${article.sections.map((section) => `<section><h3>${escape(section.title)}</h3><p>${escape(section.text)}</p></section>`).join('')}</div><div class="wiki-actions">${button('propose', '提出本機修訂 →', article.id, 'primary-small')}${button('contribute', '怎樣把提案交給整理者？')}</div>${sourcesMarkup(article.sources)}</article>`;
  }

  function renderProposal(item) {
    const revisions = item.revisions;
    return `<article class="wiki-page wiki-private-proposal" data-proposal-id="${escape(item.id)}"><div class="wiki-tags"><span class="wiki-tag private">私人本機草稿 · 未發布</span><span class="wiki-tag unverified">尚未核實</span></div><h2 class="wiki-article-title">把這段，慢慢整理。</h2><div class="wiki-notice private">只有這個瀏覽器能看見這份草稿。留版與匯出都不會更新公共原版，也不會傳給其他訪客。</div><div class="wiki-field"><label for="wiki-draft-title">標題（可以先空著）</label><input id="wiki-draft-title" maxlength="200" value="${escape(item.draft.title)}" placeholder="還沒命名也沒關係"></div><div class="wiki-field"><label for="wiki-draft-body">你的整理與保留的疑問</label><textarea id="wiki-draft-body" rows="10" maxlength="60000" placeholder="先留原話，慢慢補上脈絡、來源與不同看法。">${escape(item.draft.body)}</textarea></div><p id="wiki-save-state" class="wiki-draft-state" role="status"></p><div class="wiki-version-bar"><div class="wiki-field"><label for="wiki-revision-note">這次改了什麼（可留空）</label><input id="wiki-revision-note" maxlength="500" value="${escape(item.pendingRevisionNote || '')}" placeholder="例如：保留動機未有佐證這一點"></div>${button('save', '留一版在本機', item.id, 'primary-small')}</div><div class="wiki-actions">${button('export', '匯出提案（含原話、全部版本與異見）', item.id)}${item.publicArticleId ? button('public', '回看公共原版 ↗', item.publicArticleId) : ''}</div><details class="wiki-revisions"><summary>修訂紀錄與比較（${revisions.length} 版）</summary><p class="wiki-small">編輯區會自動保存草稿；按「留一版」才新增版本。舊版本與最初原話不會被覆蓋。</p><div class="wiki-history">${revisions.map((revision) => `<div class="wiki-history-item" data-revision-id="${escape(revision.id)}"><strong>第 ${revision.number} 版 · ${escape(revision.title || '未命名')}</strong><p>${escape(revision.note || '未附版本說明')}</p><small>${time(revision.createdAt)} · 本機未發布</small><details><summary>讀取這一版原文</summary><p>${escape(revision.body).replace(/\n/g, '<br>')}</p></details></div>`).join('')}</div><div class="wiki-compare-controls"><label for="wiki-compare-left">比較</label><select id="wiki-compare-left">${revisions.map((revision) => `<option value="${escape(revision.id)}">第 ${revision.number} 版</option>`).join('')}</select><span>與</span><select id="wiki-compare-right">${revisions.map((revision, index) => `<option value="${escape(revision.id)}" ${index === revisions.length - 1 ? 'selected' : ''}>第 ${revision.number} 版</option>`).join('')}</select>${button('compare', '顯示差異', item.id, 'quiet-button')}</div><div id="wiki-diff-result"></div></details><details class="wiki-dissent-panel"><summary>不同看法與待查問題（${item.dissent.length}）</summary><p class="wiki-small">可以保留質疑，不必把所有說法湊成一個答案。這些意見也只在本機。</p>${item.dissent.map((note) => `<div class="wiki-dissent-item" data-dissent-id="${escape(note.id)}"><p>${escape(note.text)}</p><small>${time(note.createdAt)} · 第 ${revisions.find((revision) => revision.id === note.revisionId)?.number ?? '—'} 版旁的本機異見 · 未核實</small></div>`).join('')}<div class="wiki-field"><label for="wiki-dissent-text">補一個不同看法</label><textarea id="wiki-dissent-text" rows="3" maxlength="4000" placeholder="哪裡值得再查？也可以保留另一種解釋。">${escape(item.pendingDissent || '')}</textarea></div>${button('dissent', '把這個看法留在本機', item.id, 'quiet-button')}</details>${sourcesMarkup(item.originalSources)}</article>`;
  }

  function renderClips() {
    const data = wiki();
    return `<article class="wiki-page"><div class="wiki-tags"><span class="wiki-tag private">同一份口袋筆記 · 僅本機</span><span class="wiki-tag unverified">保留不代表已證實</span></div><h2 class="wiki-article-title">先留原話，晚點整理。</h2><p class="wiki-small">來自對話裡的「留這段」或原有稍後回看。不強迫命名、分類，也不自動做摘要。</p>${data?.clips.length ? [...data.clips].reverse().map((clip) => `<section class="wiki-clip" data-clip-id="${escape(clip.id)}"><span class="wiki-tag private">${escape(clip.source.author)} · ${clip.source.origin === 'script' ? '示範腳本原話' : '本人自寫原話'}</span><blockquote>${escape(clip.source.text)}</blockquote><div class="wiki-actions">${button('from-clip', '整理成一份本機草稿 →', clip.id)}${button('clip-source', '回到原話 ↗', clip.id)}</div></section>`).join('') : `<p class="wiki-empty">目前還沒有原話。<br>回到對話，輕輕留一段就好。</p>${button('chat', '回到對話 →', '', 'primary-small')}`}</article>`;
  }

  function renderSearch() {
    const hits = searchWiki(getState(), query);
    return `<section class="wiki-search-results"><h2 class="wiki-section-heading">找到 ${hits.length} 個線頭</h2><p class="wiki-small">包括舊版本與異見；搜尋結果不是核實結果。</p>${hits.length ? hits.map((hit) => `<button class="wiki-result" data-wiki-action="result" data-id="${escape(hit.id)}" data-kind="${escape(hit.type)}" data-proposal="${escape(hit.proposalId || '')}"><small>${hit.type === 'public-article' ? '公共合成示範 · 待查' : hit.type === 'dissent' ? '本機異見 · 未發布' : hit.type === 'revision' ? `本機歷史 · 第 ${escape(hit.revisionNumber)} 版 · 未發布` : hit.type === 'proposal' ? '本機目前草稿 · 未發布' : '本機原話 · 未發布'}</small><strong>${escape(hit.title || (hit.type === 'clip' ? '口袋裡的原話' : '未命名草稿'))}</strong><p>${escape(hit.text)}</p></button>`).join('') : '<p class="wiki-empty">沒有找到。可以試試原句中的另一個詞。</p>'}</section>`;
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
    publicStatus = '正在確認同站的公共知識來源…';
    $('#wiki-public-store').textContent = publicStatus;
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
      publicStatus = '公共原版已從同站共享資料庫讀取 · 訪客寫入關閉';
    } catch {
      publicStatus = ['localhost', '127.0.0.1'].includes(location.hostname)
        ? '內附公共快照 · 本機模式，未確認共享資料庫'
        : '暫用內附公共快照 · 共享資料庫目前無法確認';
    }
    $('#wiki-public-store').textContent = publicStatus;
    // Do not replace an active private editor while it is being typed into.
    if (selected.type === 'public' && !query.trim()) { renderRail(); renderContent(); }
  }

  function updateSaveHint() {
    const element = $('#wiki-save-state'); if (!element) return;
    const error = getSaveError();
    element.textContent = error ? '本機保存未成功，請保持此頁開啟並匯出備份。' : '編輯已留在本機草稿，尚未發布；公共原版不變。';
    element.classList.toggle('error', Boolean(error));
  }

  function refresh() {
    $('#wiki-public-store').textContent = publicStatus;
    if (selected.type === 'proposal' && !proposal()) selected = { type: 'public', id: PUBLIC_ARTICLES[0].id };
    renderRail(); renderContent();
  }

  function select(type, id = '', fromSearch = false) {
    returnQuery = fromSearch ? query : '';
    selected = { type, id }; query = ''; $('#wiki-search').value = ''; 
    refresh(); root.scrollTo({ top: 0, behavior: 'instant' });
  }

  function openSource(source) {
    if (!source) return;
    if (onSource(source)) return;
    const isCanonical = sourceCatalog.some((item) => item.id === source.id && item.origin === source.origin && item.author === source.author && item.text === source.text);
    const context = isCanonical ? sourceCatalog : [source];
    dialog.innerHTML = `<h2>回到原話，而非推論。</h2><p>${isCanonical ? '這是公開合成場景的完整原文脈絡。這段尚未出現在你的本機對話裡，因此在此讀原文，不會替你新增聊天。' : '這是你在本機留下的原話快照。原句保留，不代表說法已被核實。'}</p><div class="wiki-source-context">${context.map((item) => `<article class="${item.id === source.id ? 'selected' : ''}" data-source-ref="${escape(item.id)}"><strong>${escape(item.author)} · ${item.origin === 'script' ? '合成場景原話' : '本人自寫 · 本機快照'}</strong><p>${escape(item.text)}</p></article>`).join('')}</div><div class="dialog-actions"><button class="primary-small" id="wiki-close-source">回到知識頁</button></div>`;
    dialog.showModal(); dialog.querySelector('#wiki-close-source').addEventListener('click', () => dialog.close());
    requestAnimationFrame(() => dialog.querySelector('.selected')?.scrollIntoView({ block: 'center' }));
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
      case 'source': openSource(sourceById(id)); break;
      case 'clip-source': openSource(wiki()?.clips.find((clip) => clip.id === id)?.source); break;
      case 'new': case 'propose': {
        const item = createProposal(getState(), target.dataset.wikiAction === 'propose' ? { publicArticleId: id } : {});
        if (!item) { notify('本機 Wiki 暫時無法寫入，原資料保留。'); break; }
        save(); select('proposal', item.id); break;
      }
      case 'from-clip': {
        const item = createProposal(getState(), { clipId: id }); if (!item) break;
        save(); select('proposal', item.id); break;
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
        item.pendingDissent = ''; const saved = save(); refresh(); $('.wiki-dissent-panel').open = true; notify(saved ? '不同看法已留在本機，不會覆蓋原文。' : '這個看法仍在此頁，尚未保存；請保持開啟並匯出。'); break;
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
          requestAnimationFrame(() => { if (!entry) return; entry.classList.add('wiki-search-target'); entry.tabIndex = -1; entry.focus({ preventScroll: true }); entry.scrollIntoView({ block: 'center', behavior: 'instant' }); });
        } else {
          select('clips', '', true);
          requestAnimationFrame(() => { const entry = root.querySelector(`[data-clip-id="${CSS.escape(id)}"]`); if (!entry) return; entry.classList.add('wiki-search-target'); entry.tabIndex = -1; entry.focus({ preventScroll: true }); entry.scrollIntoView({ block: 'center', behavior: 'instant' }); });
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
      save(); onOpen('wiki'); select('proposal', item.id);
    },
    openPocket() { onPocket(); },
  };
}
