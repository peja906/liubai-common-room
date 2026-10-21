# 共同工坊 · review-3 本機實驗草案

**只供程式與安全邊界審閱，投稿與回報預設關閉。不得將此草案視為可安全部署的公共服務。** 匿名公共寫入尚未獲准上線；本分支不改正式站、部署配置或公共 Wiki 只讀入口，沒有遠端 migration。

此版本同步凍結的本機逐篇處理候選，不新增功能。它使用合成資料示範待審投稿、明確回報、收件 metadata，以及可信本機整理者透過 CLI 接受、拒絕、隱藏或恢復。沒有帳號、模型接線、網路管理端點或管理憑證；接受展示不代表身分或內容已核實。

## 檔案與隔離

- `api.mjs`、`schema.sql`：投稿／回報與 metadata 回條；feed 只展示 accepted 項目，不公開待審或隱藏正文。
- `moderation.mjs`、`moderate.mjs`：本機 CLI 的狀態轉換、版本檢查與 audit；保留原稿，不覆寫或永久刪除。
- `ui.mjs`、`ui.css`：獨立表單、自寫草稿、結果未知與手動收件核對；不自動讀入私人聊天或 Wiki 草稿。
- `preview.mjs`：只綁 `127.0.0.1` 的本機覆層，使用 Node 內建 SQLite 與 D1 形狀的介面。投稿與回報預設關閉。
- `*.test.mjs`、`fixtures/review2-schema.sql`：合成 Request／DOM、記憶體及新建暫存 SQLite、CLI 與舊 schema 拒開測試。

正式 `build-site.mjs` 與 `prepare-static.cjs` 仍採原有八個前端資產清單，不匯入或打包工坊。此 schema 不修改既有公共 Wiki migration，也不會自動套用至遠端資料庫。

## 本機檢視與操作範圍

需要已安裝的 Node.js 24，無外部套件或 API key。以下只啟動投稿與回報關閉的本機預覽；請選新的合成 DB 檔名，不要使用既有資料。

```sh
node workshop/preview.mjs --port 4176 --db /tmp/liubai-workshop-review3.sqlite
```

預覽為 <http://127.0.0.1:4176>。Ctrl+C 停止，DB 保留，不自動清除；不要公開轉發此 listener。DB 必須位於暫存目錄，以 `liubai-workshop-` 開頭、`.sqlite` 結尾，新檔權限為 0600。CLI 不建立缺失 DB；預覽及 CLI 遇舊 schema 會明確拒開，不自動遷移。

本機整理者可用 `list --state pending` 取得 ID 與版本：

```sh
node workshop/moderate.mjs --db /tmp/liubai-workshop-review3.sqlite list --state pending
```

CLI 的 `accept`、`reject`、`hide`、`restore` 使用 `--id`，可附 `--expected-version` 與 `--note`。建議帶版本，避免過期決定；未帶版本則依當前狀態操作。`audit --id` 讀最近最多 100 筆事件，較早事件仍在 DB；`reports list --limit 200` 可讀完整有界回報清單。

狀態為 pending → accepted／rejected；accepted → hidden；hidden 恢復為 accepted；rejected 恢復為 pending，仍須重新接受。原稿不變，狀態／版本與 audit 同一交易；重複同一決定不增版。這是可信本機流程，audit 不保證對任意本機 DB 寫入者防竄改，也不是正式管理授權制度。

回報只送所選 ID、使用者另寫的 1–300 字理由與去重指紋，不附正文快照、聊天、Wiki 或投稿私稿。收件不代表已處理，不會自動隱藏目標。回條只提供 metadata；指紋不是作者認證或私密權杖，知道 ID 者可能查到收件狀態。

## 可重現測試

```sh
node --test tests/*.test.mjs workshop/api.test.mjs workshop/moderation.test.mjs workshop/ui.test.mjs workshop/review-boundaries.test.mjs workshop/local-safety.test.mjs
```

工坊測試使用 Node SQLite 的 `:memory:` 與自行建立的暫存合成 DB，不是託管 D1；UI 為合成 DOM／mock fetch。CLI 測試會啟動自己的本機子程序。唯一預覽子程序測的是舊 schema 拒開，在建立 listener 前即結束；這不是 HTTP 測試。測試暫存 DB 保留於 `/tmp`，不入庫。

先前限定獨立審閱沒有找到需要作者修正的確證必修反例，只支持所查本機路徑。工程曾提供 HTTP 測試結果；獨立環境的 listener 則遭 `EPERM`，0 請求／0 案例，後續未重試。本次同步也不執行 HTTP／瀏覽器驗證，不把工程結果改稱獨立 HTTP 通過。內部報告、測試紀錄、DB、圖片及部署資料均不隨程式公開。

## 已知限制與發布條件

應用層有 8 KiB 本文限制及 5 秒本文 deadline；後者從完整 headers 抵達 handler 後起算，不是慢 headers、握手或作業系統的嚴格硬上限。Origin／Fetch Metadata 不是機器人身分驗證。成功寫入配額不限制所有抵達平台的請求，也不保證匿名公平。

**投稿與回報所有狀態共用額度：6／分鐘、30／小時、100／滾動 24 小時、200 列、1 MiB canonical payload。隱藏／拒絕不釋額；滿額時新回報也會遭拒。** 既有相同回報可冪等查收，不代表新回報仍有容量。正式受理流程不能只依賴剩餘額度；SQLite 頁、索引及管理 audit 另有開銷，1 MiB 不是 DB 檔案硬上限。

隱藏後的下一次可見性快照不再提供該正文；父引用僅保留 ID／可用狀態。沒有推送清屏，不能追回已出回應、訪客既有畫面或副本。自己的本機 outbox 保留原稿是明示行為。SQL 已交付資料庫後仍可能提交，開關不保證撤銷；結果未知不能當作未寫入。

匿名公共寫入仍須先完成：

1. 可執行的前置請求／平台硬用量上限、共享範圍、觸頂停用與費用邊界。
2. 正式整理者授權、實際 DB／D1 管理路徑、受理責任與時效，以及滿額時仍可受理的管道。
3. 在已允許 loopback 的環境完成獨立真 HTTP 復驗；若擬部署，再審閱真實 D1／Worker、多實例、故障與切換行為。
4. 依最終變更作新的明確發布決定。草案 PR、限定審閱或測試通過均不是上線許可，不保證零漏洞。

本分支仍為未合併草案，沒有部署、啟用公共寫入或新增憑證／權限。授權及通用資料注意事項沿用根目錄 [LICENSE](../LICENSE) 與 [SECURITY.md](../SECURITY.md)。
