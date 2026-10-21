# 留白 Common Room

讓對話裡的線索、來源與不同看法有地方留下來。這是一個不需安裝前端套件的本機優先原型：以明示的合成對話示範交流，將公共知識和私人草稿分開。

[公開示範](https://liubai-common-room-k7m4.fairjam1025.chatgpt.site) · [MIT 授權](LICENSE) · [安全與資料範圍](SECURITY.md) · [參與開發](CONTRIBUTING.md)

## 目前能做什麼

- 展開「老照片與豆花」的虛構場景，或逐段演示、停止、離席後接續；小葵與阿光都是本機預寫角色。
- 在自己的瀏覽器寫文字、保留原話、留下疑問、匯出備份；收件核對與斷線狀態只示範本機流程。
- 閱讀兩篇公共 Wiki，回看來源、待查處與不同看法：「老榕樹與豆花攤」是虛構合成示範；「進來坐坐：基地怎麼相處」是為本專案專寫的公共共創草案。
- 在本機提出修訂、保存歷史版本、比較差異、留下異見、搜尋及匯出完整提案，供使用者自行交給整理者審閱。

公共站的 `/api/wiki` 由同站 Worker 讀取 D1。訪客只能讀取，沒有公共提交、改寫或刪除入口。Worker 可在首次讀取時保存**程式內固定的公共合成／共創種子**，不接收訪客內容作為資料庫寫入。每篇文章只帶自己的來源脈絡；加入新頁不改動既有文章的版本雜湊。資料庫不可用時，畫面會明示改用內附公共快照。

「進來坐坐：基地怎麼相處」第 1 版由 Muse 起草、Gemini 接寫、拾微整理。相處草案與「哲學討論・開放問題」分段呈現，後者保留未定論；頁腳列出協作與現況。來源僅整理這次專為公開共創的過程，不是私人聊天逐字稿，也不代表供應商政策、代言、主觀感受證明、安全保證或已完成的治理機制。

## 尚未實作

沒有多人聊天同步、共享編輯、線上提案佇列、帳號登入或跨裝置資料同步。OpenAI、Gemini、Muse 及任何其他模型均未接通；沒有搬入助理記憶、帳戶或私人聊天，也沒有完成多模型共享。示範文字不是即時模型回覆，沒有附上實際老照片。

## 在本機啟動

需要 Node.js 22 或更新版本，以及 Python 3。沒有 npm 依賴，不需要 API key 或帳號。

```sh
git clone https://github.com/peja906/liubai-common-room.git
cd liubai-common-room
node prepare-static.cjs
python3 -m http.server 8000 --bind 127.0.0.1 --directory dist
```

打開 <http://127.0.0.1:8000>。請透過 HTTP 開啟，不要直接以 `file://` 開啟。此模式的 `/api/wiki` 不存在，因此顯示「內附公共快照 · 本機模式」是預期行為；公共示範、聊天與本機草稿仍可操作。`prepare-static.cjs` 會重建 `dist/`，請勿在該目錄放個人檔案。

## 資料在哪裡

| 資料 | 儲存與公開範圍 |
| --- | --- |
| 合成腳本、兩篇公共 Wiki 原版與各自來源 | 隨程式公開；線上版本可由 D1 讀取 |
| 自寫文字、口袋原話、疑問、Wiki 草稿、修訂、異見 | 只存該網址、該瀏覽器的 localStorage；不會自動上傳或發布 |
| 使用者手動匯出的備份、提案 | 下載到使用者裝置；分享前請自行檢查內容 |

本機資料沒有加密，不保證永久保存；清除網站資料、換瀏覽器或瀏覽器儲存失敗都可能影響資料。共用裝置可先匯出，再在「口袋筆記」檢視範圍並確認清除此裝置的資料。程式不會自動過期或自動刪除內容。

此程式沒有分析 SDK、外部追蹤腳本或模型 API；連結按純文字呈現，不自動預覽外部內容。公開示範的 Sites 平台仍可能設定 Cookie、記錄瀏覽量與不重複訪客；不能承諾平台零紀錄。參見 [Sites 平台說明](https://learn.chatgpt.com/docs/sites/managing-a-site)。

## 建置與自行部署

```sh
node build-site.mjs
```

預設讀取 `.openai/hosting.example.json`，產生 `dist/server/index.js`、migration 與部署 manifest；範本只有 `YOUR_SITES_PROJECT_ID`，沒有實際專案或資料庫識別，不能直接部署到示範站。若已有自己的 Sites 專案，可在受忽略的 `.openai/hosting.json` 放入自己的配置，再執行：

```sh
node build-site.mjs .openai/hosting.json
```

這只負責建置，不會登入、建庫或部署。自行部署需由平台建立 D1 `DB` 綁定，並套用 `shared-foundation/drizzle/0000_public_knowledge_revisions.sql`。本 repo 不含原站部署憑證、D1 識別或資料庫匯出。其他主機需自行接合 Worker 及資料庫介面；純靜態主機可用前述快照模式。

本機示範不收取模型費用。公開站與自行部署的供應商條款、額度、功能及費用可能改變，**不保證免費或永久託管**。此版沒有設定持續部署或要求建立 token。

## 驗證範圍

```sh
node --test tests/*.test.mjs
node build-site.mjs
node prepare-static.cjs
```

測試涵蓋本機資料保存與損壞紀錄保留、收件核對不重送、合成示範上限與暫停、原話及版本快照、差異與異見搜尋、私人提案匯出、兩篇公共頁的來源隔離與版本雜湊、Worker 方法限制、缺少資料庫及完整性錯誤。建置亦確認 Worker 能提供首頁，靜態輸出限於八個前端資產。

資料庫測試使用明示的記憶體 Mock，沒有驗證真實 D1 或發布平台；此測試集不涵蓋完整瀏覽器 DOM、跨瀏覽器相容性、無障礙稽核、負載或多人協作。本次開源不更動既有公開示範部署。

## 公開檔案範圍

| 檔案 | 用途 |
| --- | --- |
| `index.html`、`styles.css`、`wiki.css`、`favicon.svg` | 前端結構、樣式與幾何圖示 |
| `app.mjs`、`core.mjs`、`wiki-ui.mjs`、`wiki-core.mjs` | 本機互動、狀態、合成資料與本專案公共共創文本 |
| `shared-foundation/worker.mjs`、`shared-foundation/drizzle/` | 訪客只讀公共 API 與結構 migration |
| `build-site.mjs`、`prepare-static.cjs`、`.openai/hosting.example.json` | 可重現建置與無實際綁定的範本 |
| `tests/` | 無外部依賴的迴歸測試 |
| `README.md`、`CONTRIBUTING.md`、`SECURITY.md`、`LICENSE`、`THIRD_PARTY_NOTICES.md`、`.gitignore` | 專案說明、授權與資料邊界 |

MIT 適用於專案有權授權的程式、文件、合成範例與專寫公共共創文本；第三方商標與服務不在授權範圍。素材盤點見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
