# 實作紀錄（歷史）

> 這是開發過程的逐次迭代紀錄，保留當時的決策與驗證證據，**不是**使用說明。其中提到的 `REVIEW.md`、`EXAMPLE.png`、`UI_COMPARISON_NAVICAT.md` 等早期工作檔已在公開前清理移除；現行文件請見 [docs/README.md](../README.md)。

## 2026-10-01：第一輪迭代：結果操作與多條件篩選

- Table Data 頁新增最多 30 條 AND 篩選、逐項移除已套用條件與清除全部。NULL 條件停用值輸入，空字串仍是有效值；使用既有參數化 data.select，未儲存資料修改時禁止切換篩選，條件變更回到第一頁。
- 共用 ResultGrid 支援查詢／資料表列選取、複製目前頁／選取列、CSV／JSON 目前頁匯出。以可見欄位為範圍並包含表格草稿，查詢換頁後清除選取；不自動讀取其他頁面。新增儲存格唯讀檢視器與原始內容複製，JSON 格式化保留數字字面值，避免精度轉換；大內容／深層 JSON 保持原始檢視。
- 剪貼簿及檔案儲存經固定 IPC 的 clipboard.result.copy／file.result.save，由主程序呼叫原生 API。皆為 humanOnly、16 MiB 上限，稽核只記格式／位元組數，沒有任意檔案路徑或剪貼簿讀取參數；MCP 保持 16 項工具。取消儲存不寫檔。
- 新增 result-format.test.ts 與 test:desktop:result-tools。既有一般測試 **229 passed／91 skipped**，TypeScript 及 production build 通過；UI iteration 與 UI design 桌面回歸通過。
- 最終 result-tools 桌面專項通過 AND／NULL／空結果與逐項移除、草稿保護、剪貼簿、CSV／JSON 原生儲存與取消、可見欄位／原型別／草稿內容、稽核不記錄內容、查詢換頁清除選取、八組中英文／明暗／720p／1080p 幾何與文字區可見高度，以及真實 MCP 的 16 項清單與桌面專用命令拒絕。截圖於 `.local/result-tools/`；已檢視繁中深色 720p 篩選、英文淺色 720p 長文字檢視器與繁中深色 1080p 查詢結果。
- 桌面專項測試發現瀏覽器剪貼簿在未取得焦點時可能拒絕，改走 Electron 主程序；另發現長文字區受 field-sizing 和共用 modal display 規則影響而溢出，改為具固定可見高度的內部捲動，新增文字區高度驗證。SQLite 整數依驅動回傳為文字，匯出驗收以原型別比對，不轉為 JS number。
- 使用方式與限制列於 README「結果操作與多條件篩選」。`dist/` 已更新，`release/` 未重新封裝。

## 2026-10-01：MCP 工具按功能合併

- MCP 對外工具由 80 項合併為 16 項，以必填 `action` 選擇操作。對應表在 `src/main/mcp/server/tool-catalog.ts`；README 的 MCP 章節列出完整清單與遷移範例。
- 80 個原操作皆有唯一對應，GUI 內部命令保持原樣。每個 action 保留原參數 schema、預設值與限制，經過同一 Command Bus、權限、核准、擁有者檢查與操作稽核；不直接呼叫 adapter。Observe 模式按 action 過濾，呼叫時重新檢查目前模式；舊工具名稱、未知 action、缺少 action 與混用參數會被拒絕。
- MCP Resources 保留原 URI。這是對外工具介面變更，既有 MCP client 需重新取得清單，並把呼叫改為新工具加 `action`；桌面 smoke 的 MCP 呼叫已更新。既有 `release/` 未重新封裝，`dist/` 已建置。
- 驗證：型別檢查與建置通過；完整一般測試 **227 passed／91 skipped**（36 個測試檔案通過、3 個條件式略過）。MCP 的 9 項測試包含 80 個操作的完整映射與 schema、官方 HTTP client、讀取／寫入／資源、Observe 過濾、舊名稱與非法輸入拒絕、原命令核准與 scoped grant、唯讀限制、Deny 政策及操作稽核。
- `node scripts/smoke-agent-redis.mjs` 通過真實 Electron／Redis／MCP 的 16 項工具清單、桌面核准、十分鐘授權、Redis 同步、agent 開啟查詢分頁、顯示結果與桌面取消查詢。

## 2026-09-28：SQL 物件重新命名

- Table／View／Index／Trigger 的右鍵／「⋯」選單新增重新命名；輸入新名稱、預覽 SQL、套用，顯示相依引用與各引擎重建限制。
- 新增 `object.rename_preview`／`object.rename`，沿用 Command Bus、DDL 權限、核准與 audit。驗證來源版本、名稱衝突與相關 dirty 分頁；成功後更新物件分頁的名稱／路徑、保留位置及目前分頁、重載定義並刷新瀏覽器。SQL 查詢文字不自動改寫。
- PostgreSQL／MySQL／MariaDB／SQL Server／ASE 使用對應原生語法；SQLite View／Index／Trigger 使用交易重建，MySQL／MariaDB Trigger 使用保留設定及還原機制的重建。SQLite View 可保留所屬 INSTEAD OF trigger，其他相依引用保守拒絕；並處理競爭重名時 rollback。
- SQL Server／ASE 的 sp_rename 不改 module source header；讀取 View／Trigger 時按 catalog 正規化宣告名稱和所屬資料表，確保改名後仍能編輯。特殊／約束物件仍遵循既有限制。詳細矩陣及官方文件見 [OBJECT_RENAMING.md](../features/object-renaming.md)。
- 驗證：型別檢查與建置通過；一般測試 **85 passed／29 skipped**；完整整合測試 **36 passed**，包含四組伺服器真實改名後再編輯 View／Trigger。`smoke-rename-objects.mjs` 通過四類選單、預覽、dirty／重名、樹與分頁更新、資料保留及重載持久化。已檢查 `.local/rename-object.png` 版面。ASE 僅方言測試，仍無真機環境。
- `dist/` 已更新；沒有重新封裝 `release/`。測試服務於驗證後停止。

## 2026-09-28：SAP／Sybase ASE 實驗性支援

- 目標 ASE 16.x，使用 msnodesqlv8 直接接 SAP ASE ODBC；另行安裝驅動，不沿用 SQL Server adapter／catalog。新增連線選項、port 5000、TLS 憑證路徑與型別 autocomplete。
- 沿用 Command Bus、權限、憑證與 database scope。新增 ASE metadata、參數 CRUD、有界串流分頁、取消／逾時及 session 隔離；連線中斷沿用分頁關閉機制。
- 加入 Table／View／Trigger／Index 的新增、讀取、修改及刪除方言；欄位型別／NULL／DEFAULT／改名／主鍵整合既有設計器。特殊物件採保守限制，避免重建丟失資訊；多語句 DDL 需要 ddl in tran，不宣稱原子性。
- 規劃、功能矩陣、ODBC 安裝、已知限制與真機測試說明見 [SYBASE_SUPPORT.md](../engines/sybase-support.md)。DECIMAL／MONEY 等無法保證精度的結果明確拒絕；EXPLAIN、全預設值 insert 及跨次 session 狀態尚未支援。
- 驗證：`npm run build`（含型別檢查）通過；`npm test -- --maxWorkers=2` 為 **79 passed／25 skipped**，其中 ASE 有 12 項協定／catalog／SQL／命令服務測試。`smoke-sybase.mjs` 通過真實 Electron 表單、TLS 必填、缺少驅動、儲存／編輯與憑證保護；`smoke-object-tabs.mjs` 與 `smoke-structure.mjs` 通過既有 Index／Trigger、Table／View 設計器操作回歸。並行建置期間曾遇 MCP test worker 異常退出，分開重跑 MCP 及全套測試後通過。
- **沒有 ASE 測試伺服器，未宣稱真機通過**。已提供 `npm run test:sybase` 與 opt-in 整合測試，目前跳過。本輪未重新封裝 `release/`，`dist/` 已更新。

## 2026-09-28：Code Review 修正

- 原審查七項問題已有六項完整修正；SQL Server 精度問題在 SQL 帳密路徑修正，Windows 原生驅動另有明確限制，詳見 [CODE_REVIEW_2026-09-28.md](code-review-2026-09-28.md)。
- MySQL／MariaDB 非唯讀 SQL 結束銷毀 session，避免 USE／SET／交易污染後續資料庫 scope。跨次執行不保留 session 狀態。
- 表格載入期間停用編輯，先提交尚未失焦的輸入到草稿；讀取結果檢查草稿版本，更新條件固定為原始主鍵，零列更新回報衝突並保留草稿。
- DDL 十分鐘授權綁定完整驗證後表單。連線名稱／群組／顏色不斷線；端點與憑證變更、刪除連線共用未儲存確認／查詢取消／分頁關閉流程，避免孤立分頁。
- 預設列 INSERT 依引擎產生語法，五種 SQL 配置覆蓋全部預設值、純自動編號、必要欄位缺漏拒絕。
- SQL 帳密驅動固定 Tedious 20.0.0，窄範圍替換 DECIMAL／NUMERIC 封包解碼，以 BigInt 組合精確文字，含 SQL_VARIANT 小數。Windows NUMERIC 保留原生精確字串；msnodesqlv8 的 DECIMAL 在 native 層先經 SQL_C_DOUBLE，故 guard 拒絕 DECIMAL／SQL_VARIANT 結果，避免假精度。這仍限制 Windows 資料表瀏覽，須使用 SQL 帳密或明確在 SQL 端轉 NVARCHAR，尚未實作 Windows DECIMAL 的透明無損讀取。
- 驗證：型別檢查／建置通過；一般測試含 Windows 實機驗證共 68 通過、23 條件式略過；既有資料庫整合 17 項及新增回歸 10 項通過。新增 `test:desktop:review` 通過慢速讀取、尚未失焦的輸入、草稿、原始主鍵與刪除連線；SQL Server 桌面 smoke 通過封裝前 Electron 的精確字串、Windows 限制與替代讀法；既有 UI smoke 的部分儲存、插入表單、NULL／預設值與兩種解析度布局也通過。整合測試服務已停止，本輪未重新封裝安裝程式。

## 2026-09-28：SQL 物件新增／修改／刪除盤點

驗證：`npm test -- --maxWorkers=1` 63 通過／17 條件式略過；`npm run test:integration -- --maxWorkers=1` 17 通過；`npm run build` 通過；桌面 smoke 覆蓋四類物件新增與右鍵刪除、取消、髒分頁捨棄確認。

- 四類物件共 12 項基本操作，既有新增／修改 8 項，本輪補齊刪除 4 項；詳細邊界見 [OBJECT_CRUD_AUDIT.md](../features/object-crud-audit.md)。
- Table／View／Index／Trigger 右鍵刪除，浮動 SQL 確認，所屬物件／分頁清單，髒分頁捨棄確認，定義版本檢查與 destructive 權限分類。
- 刪除成功關閉相關物件分頁，新增／修改／刪除事件更新瀏覽器；Index／Trigger 選單明確標示「修改定義」。
- 五種 SQL 測試配置包含 SQLite、PostgreSQL、MySQL、MariaDB、SQL Server 的完整基本生命週期；另含權限、髒分頁、過期版本與 SQLite 相依 view 回滾案例。

# PLAN.md 實作追蹤

## Table／View／Index／Trigger 建立分頁（2026-09-28）

- 四類群組增加「＋」與右鍵建立入口；獨立 create 分頁提供名稱／Schema、欄位型別與 NULL／PK／預設值、View SELECT、索引順序／唯一性、依引擎與目標類型調整的 Trigger 選項。沿用欄位型別自動完成與獨立精度／小數位欄位。
- 新增共用 `app.open_create_object`、`object.create_preview`、`object.create`。後端驗證識別字、欄位片段、Schema／目標、索引欄位與觸發時機；預覽只讀取 metadata。建立走既有 DDL 權限／核准／audit 與 adapter；不用 CREATE OR REPLACE，不覆寫既有物件。
- PostgreSQL 可建立 PL/pgSQL trigger function 並與 Trigger 同交易提交，亦可指定既有零參數函式；SQL Server 使用單獨 batch、SQLite 使用交易、MySQL／MariaDB 維持單敘述 DDL 並提示隱式提交。
- 草稿以工作區保存，重載保留 dirty 狀態；建立後刷新瀏覽器、提供開啟物件，失敗保留表單。能力矩陣與本輪界線見 `OBJECT_CREATION.md`。
- 63 項一般測試與 17 項真實整合測試通過，涵蓋五個 SQL 引擎實際建立四類物件、Trigger 觸發、重名拒絕、預覽不寫入、唯讀 agent 拒絕、PostgreSQL 函式回滾；MySQL／MariaDB IF／CASE 觸發內容亦通過。建置及 `smoke-create-objects.mjs` 通過：四類入口、右鍵選單、草稿重載／關閉保護、建立 SQL 預覽、樹狀列表刷新、開啟新物件定義。已檢視 `.local/create-table-form.png` 與 `.local/create-object-form.png`。未重新封裝 `release/`。

## Redis 七種型別與 Stream／JSON（2026-09-27）

- 補上 Stream 的 XRANGE 分頁、XADD 新增及 XDEL 刪除，保留項目 ID 字串、重複欄位與空串流。桌面以 ID／動態欄位列表顯示內容，既有項目不提供不正確的原地編輯操作。
- 辨識 `ReJSON-RL`／`json` 原生型別，以 JSON.GET 取得格式化原文、JSON.SET 修改完整文件；支援 root 物件／陣列／純量，避免前端重新序列化造成大整數精度遺失。伺服器缺少 JSON 能力時回報明確訊息，語法與 UTF-8 大小驗證在寫入前完成。
- 沿用 Command Bus、權限／核准、DB 範圍與 cursor 隔離；刪除 Stream 項目走 delete 政策。其他模組型別可顯示 metadata／TTL，不會錯用 zset 編輯器。修正載入後 TTL 被重設為 -1 的問題。
- 新增 Redis 8.2 整合服務（127.0.0.1:16380）驗證原生 JSON，保留 Redis 7.4 回歸。62 項一般測試、4 項 Redis 真實整合測試、型別檢查與建置通過；`smoke-redis-types.mjs` 通過七種型別開啟、Stream 分頁／新增／刪除、JSON 新增／修改與 TTL 保留。已檢視 `.local/redis-stream.png`。既有 `smoke-agent-redis.mjs` 五種型別編輯／TTL／MCP 核准回歸亦通過。未重新封裝 `release/`。

## Redis 多資料庫瀏覽與範圍隔離（2026-09-27）

- 資料庫瀏覽器列出 Redis DB 編號與 key 數量，點選後開啟／啟用對應 DB 分頁；新增／刪除 key 自動更新數量，提供手動重新整理。中斷連線一併移除所有 DB 分頁與列表。
- `redis.databases` 經共用 Command Bus 與讀取權限取得 `CONFIG GET databases`、`INFO keyspace`；依伺服器設定列出空庫，偵測 cluster metadata 時只列 DB 0。metadata 權限不足時標示推定列表，無法取得 key 數量時顯示「—」，網路錯誤正常回報。
- `app.open_redis` 與全部 Redis 讀寫指令支援 `database` 字串；省略時使用連線預設值。每個 DB 使用獨立 adapter，避免並行 SELECT 導致跨庫操作；cursor 與變更事件同時綁定 DB。重複開啟同一 DB 沿用分頁，Redis 可同時開啟最多 128 個 DB，SQL 的既有 8 個 scope 上限不變。
- 驗證：60 項一般測試通過；2 項 Redis 真實整合測試通過（五種型別／權限／TTL，以及 DB 0、12、15 同名 key 隔離、跨 DB cursor 拒絕、16 個 DB 可開啟、連線中斷）。建置與 `smoke-redis-databases.mjs` 通過，包含 DB 選取、DB 12 編輯／刪除、數量更新、分頁沿用與中斷清空；已檢視 `.local/redis-databases.png`。既有 `smoke-agent-redis.mjs` 五種型別／TTL／MCP 核准與同步流程亦通過，並更新其已過時的工作區標題定位。未重新封裝 `release/`。

## 連線生命週期與真實狀態（2026-09-27）

- 卡片讀取主程序執行時狀態，灰／黃／綠燈顯示未連線／連線中／已連線。單擊只選取，雙擊或 Enter 連線；離線顯示「雙擊以建立連線」。App 啟動不會因還原分頁而連線；離線分頁不掛載資料讀取元件。
- `connection.disconnect` 經 WorkspaceService 檢查未儲存修改並關閉全部相關分頁，取消執行中查詢、關閉所有 scope adapter。renderer 收到狀態事件後清空瀏覽器，失效舊 metadata 請求；其他連線與分頁保留。
- ConnectionService 以連線世代使延遲完成的連線與舊 adapter handle 失效，driver 關閉前等待已發出的工作收束；明確中斷後阻止隱式重連，僅 `connection.connect` 可重新開啟。
- 驗證：57 項一般測試通過，9 項真實資料庫整合測試通過；建置與 `smoke-connections.mjs` 通過（冷啟動／還原分頁離線、單擊不連線、雙擊連線、取消捨棄、相關分頁關閉、其他連線保留、重新連線）。原有 `smoke-electron.mjs` 桌面回歸亦通過，包含資料編輯、查詢、分頁、選單與語言切換。未重新封裝 `release/`。

## 結構訊息改為工具列浮動提示（2026-09-27）

待套用、套用完成、錯誤與唯讀原因統一放在「重新整理結構」左側的固定提示位置。點擊後使用原生 popover 顯示欄位變更前後值及 PK 隱含的 NOT NULL，支援 Esc、關閉鈕、外部點擊。移除設計器內的待套用橫幅，工具列不換行，避免訊息造成列表位移。型別檢查與建置通過；桌面回歸新增提示出現、展開、清除時列表位置不變及浮動視窗關閉操作驗證。截圖：`.local/structure-notice.png`。

## 最新迭代：依 Navicat 參考圖改善欄位設計（2026-09-27）

- 欄位列表可直接編輯名稱、型別、獨立長度／精度、小數位數、NULL 及 PK；型別清單依引擎提供自動完成，允許完整宣告與自訂型別。SQL Server MAX、PostgreSQL numeric 負 scale、SQLite STRICT 建議清單與 MySQL 舊式顯示寬度提示均有區分。
- 每列 PK、屬性面板及主鍵頁同步，支援複合主鍵及新增欄位 PK。主鍵與欄位屬性可一併保存／預覽／套用；主鍵不可 NULL，移除未套用的主鍵不會清除原本明確設定的 NOT NULL 草稿。
- `edit-columns.primaryKey` 使用原欄位識別字，合併改名後依引擎產生正確約束；SQLite 一次重建，MySQL／MariaDB 一個 ALTER TABLE，PostgreSQL／SQL Server 一個交易。新增主鍵與批次主鍵修改均受 destructive policy 控制。
- 型別與 SQL 計畫測試、四種真實伺服器整合測試已通過；涵蓋新增 PK、型別／NULL／預設值／複合 PK／主鍵欄位改名，以及 SQLite 失敗回滾。專案建置與桌面驗證證據見本輪記錄；`release/` 未重新封裝。
- 本輪驗證：`npm test` 55 通過／10 條件略過，`npm run test:integration -- -t "real structure editing"` 4 通過，`npm run build` 與 `node scripts/smoke-structure.mjs` 通過。桌面測試涵蓋列內型別、精度／小數位數、複合 PK／NULL、PK 切換保留 NOT NULL 草稿與舊草稿恢復。已檢視深色與 1280×720 淺色截圖；`.local/table-designer-grid.png` 為新版列內操作畫面。

## 前輪修正：設計器欄位屬性互鎖（2026-09-27）

- 修正 NULL 草稿存在時名稱、型別及其他欄位停用的問題。名稱／型別／NULL／預設值可跨欄位連續修改；改回原值只撤回該項，舊版單項草稿可繼續編輯。
- `edit-columns` 經既有 Command Bus、嚴格 schema、版本檢查及 audit 套用；其中含型別變更時，整批按 destructive policy 處理。
- SQLite 合併為一次交易重建，最後執行改名；MySQL／MariaDB 合併為單一 ALTER TABLE，保留未修改的完整欄位屬性；SQL Server 轉型前移除預設值約束，之後恢復原值或指定的新值；PostgreSQL／SQL Server 沿用整批交易。
- 新增／刪除欄位與主鍵仍分開操作。沒有重新封裝 `release/`；專案 `dist/` 已重新建置。
- Electron `node scripts/smoke-structure.mjs` 通過：舊版 NULL 草稿重新載入後名稱／型別可編輯、跨欄位草稿保留、只還原 NULL 後合併套用、失敗完整回滾，以及原有新增／刪除／主鍵／View／版本衝突流程。
- 驗證：`npm test` 53 通過／10 條件略過，`npm run build` 通過；四種伺服器的 `real structure editing` 整合測試通過，涵蓋跨欄位合併、型別／NULL／預設值與改名、SQL Server 原預設值保留。啟動測試服務後執行，完成後停止服務；一次測試 worker 異常退出，獨立重跑 4 項全部通過。

此文件對照原始 PLAN.md 的完整 Phase 1 範圍，不取代或縮減計畫。主要功能與實際資料庫／Electron 流程均已實作；最新發行包驗證結果見下方。

## 已有證據

- `npm run typecheck` 通過。
- `npm test`：37 個測試通過，使用真實 SQLite worker 與官方 MCP HTTP client。包含單次／暫時核准、到期／撤銷／拒絕、cursor caller isolation／expiry／single use、取消、UTF-8 byte cap、單敘述界線、secret redaction、verified TLS、rate limit、並發 session cap、idle cleanup 與 token rotation。
- `npm run test:integration`：5 個真實服務測試通過（PostgreSQL 17、MySQL 8.4、MariaDB 11.4、SQL Server 2022、Redis 7.4）；涵蓋 SQL cursor 逐頁結果、跨 database 查詢且 default scope 不變、EXPLAIN（包含 SQL Server）、metadata、CRUD、核准、timeout、reconnect、Redis 五種型別／cursor／TTL。
- `npm run build` 最新版本通過，包含 main／sandboxed preload／React renderer。
- `node scripts/smoke-electron.mjs` 通過：真實 Electron、SQLite connection form、group/favorite/color/search/reconnect、Explorer columns、numeric/empty/NULL roundtrip、insert/filter/delete/sort/visibility、dirty History/close guard、拖曳 tabs、自動完成、Find/Replace、table/query pagination、Ctrl+Enter 選取 SQL、History re-run、close others、繁中／英文切換與持久化；`.local/desktop-smoke.png`、`.local/desktop-zh-TW.png`。
- `node scripts/smoke-scopes.mjs` 通過：database/schema tree、各範圍正確資料、既有 tab 保留原 database/schema、App Context；長名稱 layout 修正後重新測試通過，`.local/database-scopes.png` 已視覺檢查。
- `node scripts/smoke-agent-redis.mjs` 通過：Redis 五種型別 UI、value／TTL／zset score 編輯、dirty guard、OS 加密儲存、官方 MCP client → Electron → 單次／10 分鐘核准 → Redis 即時刷新、Agent 開 query／result、connected/running indicator、桌面取消 Agent 查詢與恢復。
- `npm run package` 已成功產生最終 Windows `release/win-unpacked`。`node scripts/smoke-packaged.mjs` 與 `node scripts/smoke-packaged.mjs --agent` 均通過；包內 main/preload/renderer 入口與最後 build 逐 byte 比對一致。隱藏視窗截圖改用 Electron capture API，避免 CDP 等候隱藏 compositor frame 逾時。

## 逐項實作與驗證

| 計畫章節                                       | 實作與驗證狀態                                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1–4 產品／共用架構                             | Application、Command Bus、Event Bus、Permission、Audit、Credential 與共用服務已建立，五種 adapter 已齊全；有真實引擎與 Electron 證據。                                                                                         |
| 5 連線管理                                     | 五種 adapter 的新增、編輯、刪除、測試、連線、斷線與 Reconnect 已接；實際資料庫及桌面 Reconnect 通過。                                                                                                                          |
| 6 側邊欄                                       | 群組、favorite、color、搜尋已實作且有 desktop assertions。                                                                                                                                                                     |
| 7 Explorer                                     | database/schema/table/view/column metadata、column tree、database/schema tree 與 scope 傳遞已接；真實引擎與桌面 scope 測試通過。                                                                                               |
| 8 Workspace                                    | 開／關／關其他／拖曳排序／dirty guard／持久化已實作並通過 desktop 驗證；切換 History/Activity 保留草稿。                                                                                                                       |
| 9–10 SQL Editor                                | 離線 Monaco 的 syntax/line number/indent/find/replace/autocomplete、執行選取／快捷鍵、取消、設定已接；補完限定目前 editor model，SQL 文字自動保存並清理持久化憑證。                                                            |
| 11 Query Result                                | TanStack + virtualization、row count／duration／affectedRows、cursor、所有 SQL adapters 的 8 MiB row/page cap 已接；真實 GUI 分頁與 UTF-8／超大 row 邊界測試通過。                                                             |
| 12–16 Table/CRUD                               | Data/Structure、filters/sort/pagination/resize/visibility、PK 更新、insert/delete、numeric/boolean/NULL 已接。儲存期間鎖定操作；逐列提交失敗時保留未提交修改。跨 view 草稿與外部變更通知已接。                                 |
| 17–18 Redis                                    | SCAN、五種型別、CRUD、TTL、opaque cursor／bounded pagination 完成。大型 Unicode 字串、cursor actor isolation、鍵型別改變均測試；Set 複製／移除與 zset score 編輯語意明確，dirty guard 已桌面驗證。                             |
| 19 History                                     | 保存／搜尋／copy／open query／Re-run，保留原 database；SQL 密碼語法、URL、Bearer、known-secret 遮罩有測試。                                                                                                                    |
| 20 Settings                                    | theme/language/page size/font/tab/wrap/timeout/max rows/Agent policy 已接。繁中／英文 UI 和持久化、SQL Server timeout、Monaco system theme 均有實作／驗證。                                                                    |
| 21–25 MCP/transport/auth                       | 官方 SDK Streamable HTTP、disabled default、loopback、TLS remote、Bearer token、rotation 完成；真實 HTTPS request 使用測試憑證驗證，無停用憑證檢查。完整 OAuth 依原計畫列為後續。                                              |
| 26–27 Permission                               | connection disabled/read/write、observe/assist/execute、policy enforcement、SQL／Redis approvals、cross-actor cursor、expiry／revocation 已有測試。                                                                            |
| 28–33 App/Connection/Schema/Query/Data tools   | SQL tools、EXPLAIN、query.next、database scope 已完成並有各 SQL 引擎測試；GUI / MCP 同用 services。                                                                                                                            |
| 34 Redis tools                                 | 所有列出的 read/write tools 與其他型別編輯 tools 都已透過 Command Bus 暴露；Redis integration 與 Electron MCP 核准測試通過。                                                                                                   |
| 35–39 Resources/context/sync/buses             | 四種 URI 完成；schema resource 含各 schema/tables，table resource 含名稱與 columns。Context 提供目前 connection/database/schema/table/query tab/selectedRows，GUI 與 Agent 共用 bus/events。app://selection 依原計畫留作後續。 |
| 40–42 Approval/destructive                     | 原始參數綁定、human-only、到期／拒絕／單次消耗／政策重查均測試。持續核准限 session+operation+target 10 分鐘，SQL 綁定語句，破壞性操作逐次核准。Redis TTL=0 按 delete 政策。                                                    |
| 43–46 Activity/audit/credentials               | 結構化 audit、憑證／error／history／workspace persistence redaction、safeStorage 已驗證；audit.list 不再為自身加入 audit。                                                                                                     |
| 47–49 Tool contracts/results/large results     | Zod、structuredContent、table offset pagination、各 SQL row/byte bounds、query opaque cursor／Redis cursor 完成，真實引擎分頁與 byte boundary 測試通過。                                                                       |
| 50–53 Workflows/Phase 1 tools/resources/status | 官方 MCP client → Electron → shared context／SQL tab/result／Redis approval 已端到端驗證；connected/running indicator 與桌面 Stop 取消 Agent 查詢已實測。                                                                      |
| 54 Remote security                             | Host/Origin、Bearer、每 IP 120/min、32 sessions（含初始化名額）、30 分鐘 idle cleanup、TLS、rotation 均有實際 HTTP/HTTPS 測試。                                                                                                |
| 55–56 Electron structure                       | 符合 main/application/database/mcp/credentials/preload/renderer 分層；自訂 protocol、sandbox、IPC sender 驗證與 safeStorage 已有真實 Electron runtime 證據。                                                                   |
| 57–58 完整交付                                 | Phase 1 功能、README、Windows 發行包完成；最終打包版 SQLite 與 MCP／Redis 桌面流程均通過。                                                                                                                                     |

## 交付界線

Index／Trigger 詳細內容已由樹狀展開改為獨立唯讀 Tab Content；雙擊物件經 `app.open_object` 開啟，保存物件種類、名稱、database/schema/table 參照，分頁內重新讀取 metadata。`smoke-object-tabs.mjs` 已實測 Index 與 Trigger 分頁、無樹內定義、切換／關閉、重新載入後還原，以及物件刪除後重新整理的錯誤提示。建置通過；原測試 44 項通過，1 項 MCP 隨機連接埠錯誤，單独重跑 MCP 6 項全部通過。`.local/database-object-tabs.png` 已視覺檢查。

可調整欄寬的完整 Electron smoke 已通過：滑鼠拖曳兩欄分隔位置、分隔線鍵盤方向鍵、Index 定義展開、Trigger 空清單，以及既有 SQLite 編輯／分頁／草稿保存／SQL 快捷鍵流程。

Index／Trigger／Query 與可調整欄寬：每個 database 下增加延遲載入的 Index、Trigger 清單與 Query 入口。`index.list`、`trigger.list` 經共用 Command Bus 的唯讀權限執行，支援 SQLite、PostgreSQL、MySQL／MariaDB、SQL Server；物件可展開所屬表及可取得的定義／摘要。Query 已實測開啟指定 database 的 SQL 分頁。主框架使用 shadcn Base Resizable 的 Group／Panel／Handle 組合，以原有 CSS tokens 適配樣式；來源授權保存在 `licenses/shadcn-ui.txt`。建置、45 項測試（6 項環境測試跳過）與 5 項真實資料庫整合測試通過，涵蓋各引擎實際索引／觸發器 metadata。`.local/database-object-tree.png` 已視覺檢查。

樹狀層級修正：database 下直接顯示 Table／View 分類，再列出物件與欄位，不再使用 schema 中間層。多 schema 的物件以 `schema.名稱` 區分，metadata 與開啟命令保留原 schema。建置及 PostgreSQL 桌面 scope 測試通過：Table／View 分類、View 開啟、跨 schema 同名表、既有分頁範圍與新增資料庫。實際畫面 `.local/database-object-tree.png` 已檢查。

資料庫瀏覽器已移除 database/schema 下拉選單，改為按需展開的 database → schema → table/view → column 樹狀結構，支援重新整理與名稱搜尋。`database.create` 經共用 Command Bus、DDL 權限、audit 與核准流程執行；PostgreSQL、MySQL、MariaDB、SQL Server 的真實建立／重名錯誤／清理測試通過。SQLite 使用新增檔案連線流程，Redis 顯示伺服器設定說明。44 項測試與 5 項真實資料庫整合測試通過；`smoke-scopes.mjs` 驗證樹狀切換、既有分頁範圍固定及 GUI 建立資料庫成功。`.local/database-scopes.png` 已視覺檢查。

2026-09-27 `EXAMPLE.png` 視覺調整：石墨色深色配色、藍色漸層操作按鈕、緊湊工具列／Tabs／表格、獨立連線清單與 Database Explorer、資料表搜尋，以及配套 Monaco 深色語法主題。新設定檔預設 dark，保留既有設定。建置與 42 項測試通過（6 項環境測試跳過）；完整 Electron smoke 通過，包含分欄 Explorer 搜尋、SQL、資料編輯、分頁及未儲存草稿保存。已檢查 `.local/desktop-smoke.png` 與 `.local/settings-layout.png` 的實際畫面。參考圖中的展示資料及尚未實作功能未加入產品；本次未重新封裝 release。

2026-09-27 REVIEW.md 介面調整完成：自訂 File 選單（新增連線、設定、最小化、關閉），保留 Edit／View 並移除 Window；設定對話框採固定 Header／Footer 與獨立內容捲動；主畫面採頂部全域工具列、左側搜尋連線及右側頂部分頁。建置及 42 項測試通過（6 項需資料庫環境的測試跳過）。Electron smoke 實測最小視窗布局、選單開啟對話框、固定區域位置、焦點循環與 Escape，並通過既有 SQLite 編輯／SQL／分頁／草稿保存流程。畫面證據：`.local/settings-layout.png`、`.local/desktop-zh-TW.png`。本次更新原始碼與 dist，未重新產生 release 發行包。

SQL Server 更新的 Windows 發行包位於 `release/sqlserver-auth/win-unpacked`，已通過 `smoke-sqlserver-auth.mjs --packaged`：實際 Windows 身分登入、SQL 帳密登入、兩種連線並存、表單切換及重新載入後保存。由於舊版程式仍在執行，本次使用獨立輸出目錄。

SQL Server 連線已增加 SQL 帳密與 Windows 整合驗證選擇。Windows 模式使用目前程序身分，前後端都限制 Windows 平台，切換儲存時清除舊帳密。原有連線預設 SQL 驗證。Windows 實機測試包含 NTLM／Kerberos 驗證方式檢查、參數查詢、metadata、EXPLAIN、重連、列數限制、錯誤／逾時後復原；桌面測試涵蓋表單切換、設定持久化及兩種驅動並存。`TEST_WINDOWS_SQLSERVER=1` 的測試結果為 43 項通過，另 5 項 Docker 整合測試獨立執行通過。使用方式與 ODBC Driver 18 前置需求見 README。

- SQL cursor 是重跑查詢的即時分頁，不是交易快照；文件要求 ORDER BY 並說明並行變更影響。
- Save changes 逐列提交，非跨列原子交易；失敗時保留剩餘草稿。
- 驗證平台為 Windows。macOS／Linux 封裝設定存在，但未宣稱已實機驗證。
- 完整 OAuth、ERD、migration、backup、profiler、import/export wizard 等原計畫後續項目不納入 Phase 1。

測試環境可用 `npm run integration:up`／`npm run integration:stop` 管理；僅操作 `database-workspace-integration` compose project。測試密碼在忽略版控的 `.local/integration.env`，不得輸出到紀錄或文件。

## Index / Trigger 可編輯分頁（2026-09-27）

已把唯讀物件分頁改為 SQL 定義編輯頁：保留原始定義、草稿、dirty 提示、還原、預覽實際 DDL 與套用按鈕。草稿及基準版本保存至 workspace，重新載入後可繼續；套用失敗保留草稿，重新整理／關閉使用既有捨棄確認。

新增共用 `object.describe`／`object.preview`／`object.apply`，沿用 Command Bus DDL 權限、Agent 核准、audit、固定 IPC 與事件。名稱、schema、資料表固定；套用前重新讀取並核對 SHA-256 版本，對同一 adapter 的套用序列化。這是樂觀版本檢查，沒有承諾跨外部資料庫 session 的排他保護。

SQLite／PostgreSQL 同一 session 交易替換；SQL Server 以獨立 session 的交易執行 DROP_EXISTING／ALTER TRIGGER，保留停用狀態、模組 SET 選項與觸發順序。MySQL／MariaDB 從 SHOW CREATE 取得完整定義，索引用單一 ALTER TABLE，觸發器重建保留 SQL mode、definer、順序；建立失敗時嘗試重建原 trigger，成功與失敗分別回報。原生 SQL 一般查詢的單敘述限制未放寬。

功能分析、原廠文件連結及唯讀例外列在 [OBJECT_EDITING.md](../features/object-editing.md)。不把 SQLite 自動索引、資料表約束、PostgreSQL partition／replica-identity 索引或 SQL Server 特殊索引轉成不完整腳本。

驗證證據：

- `npm run build`：通過，包含 TypeScript 檢查與主程序／renderer 建置。
- `npm test`：47 通過、6 跳過（環境限定整合測試）。
- `npm run test:integration`：5 通過，包含 PostgreSQL、MySQL、MariaDB、SQL Server 的實際索引修改、trigger 修改、失敗回復；MySQL／MariaDB 驗證多 trigger 順序及 invisible／ignored 索引，SQL Server 驗證停用狀態保留。
- `node scripts/smoke-object-tabs.mjs`：通過，涵蓋編輯、預覽、套用、trigger 實際改寫資料、錯誤保留草稿、草稿還原、切換／關閉、刪除後重整提示。
- `node scripts/smoke-electron.mjs`：通過，原有完整桌面流程及 Index 分頁未退化。
- SQLite 單元測試涵蓋原子回復、過期版本、固定物件範圍、多敘述 trigger、DDL 拒絕與人工核准；SQL Server 整合測試拒絕附加無分號的第二個批次命令。
- 已檢視 `.local/database-object-tabs.png`：編輯區、工具列與分頁呈現正常。

本次沒有重新打包 release 執行檔；`npm start` 使用已更新的 dist。

## Table / View「結構」頁面編輯（2026-09-27）

Table 結構頁新增欄位操作選單與表單，可新增、重新命名、修改型別／允許 NULL／SQL 預設值、刪除欄位及編輯主鍵。View 使用完整定義編輯區。兩者都有 SQL 預覽、套用、還原、錯誤保留草稿及結構版本檢查。成功後刷新資料頁欄位，清除失效排序與篩選；資料列草稿與結構草稿不交叉編輯。

主程序新增 `structure.describe`／`structure.preview`／`structure.apply`，GUI 與 MCP 共用既有命令／權限／核准／稽核。新增、NULL、default 與 View 使用 DDL policy；刪欄、轉型及主鍵替換使用 destructive policy，暫時授權綁定完整變更內容。草稿保存到工作區；原生關閉對話框選擇捨棄時會清除結構草稿及版本，查詢文字仍保留。

SQLite 重建在同一 worker／交易內備份並搬回資料，保留可存取的 rowid、AUTOINCREMENT 高水位、產生欄位、索引與 Trigger，提交前驗證外鍵及 View。PostgreSQL／SQL Server 使用原生 DDL 與同一 session 的交易；MySQL／MariaDB 一次一個原生 ALTER，保留其他欄位屬性。完整差異及限制列於 [STRUCTURE_EDITING.md](../features/structure-editing.md)。

驗證證據：

- `npm run build`：通過，最後產物已更新至 dist。
- `npm test`：50 通過、10 跳過（環境限定測試）。涵蓋 SQLite 資料／外鍵子列／索引／Trigger／generated column／rowid／sequence 保留、重建失敗回復、過期版本，以及精確變更核准與 destructive policy。
- `npm run test:integration`：9 通過。新增 PostgreSQL、MySQL、MariaDB、SQL Server 四組 Table 欄位與 View 定義實測，驗證完整型別長度、新增預設值回填、修改型別／NULL／預設值、改名、刪欄、主鍵與 View 修改、無效定義回復及版本衝突。
- `npm run test:desktop:structure` 與最終 `node scripts/smoke-structure.mjs`：通過，涵蓋表單編輯、預覽／套用、資料頁欄位更新、關閉取消、重新載入草稿、失敗回復、View 結果更新、外部版本衝突，以及原生「捨棄並關閉」清除持久化草稿。
- `node scripts/smoke-electron.mjs`：通過，既有連線、SQL／資料列編輯、可調欄寬、分頁、設定及分頁查詢流程正常。
- 已檢視繁中畫面 `.local/structure-editor.png`，View 欄位資訊、定義編輯區及操作工具列顯示正常。
- 專用 Docker 整合服務已停止；本次未重新打包 release 執行檔。

## Navicat 介面第一輪迭代（2026-09-27）

依 `UI_COMPARISON_NAVICAT.md` 完成 P0 核心與部分 P1，沒有變更 Command Bus、權限或 adapter 契約。

- 新增 `ActionMenu`，用於物件右鍵／更多選單與分頁選單，支援鍵盤導航、Escape 與焦點還原；Table／View 可直接進入結構頁並沿用既有分頁。
- 新增 `WorkspaceScope`，顯示分頁自己的連線與 database/schema/object 來源；跨來源同名分頁補充來源標籤。
- 抽出 `QueryView` 與 `SqlEditorHandle`，執行按鈕／快捷鍵共用文字擷取與提交入口；空白不送出，連續觸發以同步的提交鎖防護。
- 連線清單可收合、導覽寬度記憶；SQL 編輯器／結果可上下調整並記住比例。
- 新增 `InsertRowDialog` 欄位表單，維持 `data.insert` 路徑；JSON 驗證、值模式切換與資料庫失敗皆保留輸入，成功寫入後即使刷新失敗也不讓同一筆成為待重送狀態。
- 篩選摘要／清除、排序指示、儲存格修改標記、修改列數、部分提交回饋與導覽繁中翻譯。
- 回歸測試發現並修正原有網格問題：`ResultGrid` 的 column cell renderer 隨 onEdit callback 重建，可能在換欄位時卸載其他儲存格而丟失尚未 blur 的文字。現在固定 renderer 身分並以 ref 取得最新編輯 callback。

驗證：

- `npm run typecheck` 與最終 `npm run build` 通過。
- `npm test`：51 passed、10 skipped；跳過項目依既有環境條件，這輪未重跑外部資料庫服務測試。
- `node scripts/smoke-object-tabs.mjs` 通過，涵蓋 Index／Trigger 開啟、定義套用、草稿還原及錯誤處理。
- `node scripts/smoke-structure.mjs` 通過，涵蓋欄位與 View 修改、SQL 預覽、dirty／stale guard 與失敗草稿保留。

- `node scripts/smoke-ui-iteration.mjs` 通過：鍵盤開啟物件、連續編輯、部分儲存失敗保留草稿、既有分頁切換保護、JSON 錯誤驗證、失敗後重試、預設值／布林／NULL 寫入，以及 1280×720 淺色和 1920×1080 深色版面。
- 已檢查 `.local/insert-row-form.png`、`.local/ui-iteration-light.png`、`.local/ui-iteration-dark.png` 與結構編輯截圖；結果區填滿可用高度，工具列沒有水平溢出。
- `node scripts/smoke-electron.mjs` 最終回歸通過：SQL 按鈕／快捷鍵提交完全相同的選取文字、物件選單直接設計、表單／JSON 切換、清除篩選、連線欄收合、查詢區調整及分頁選單，並涵蓋原有資料編輯、分頁、歷史紀錄與語言切換。
- 所有本輪修改的程式與測試檔通過 Prettier 格式檢查。

界線：結構屬性面板、完整網格鍵盤模型、圖示系統與 P2 功能仍按比較報告追蹤。`release/` 本輪未重新封裝；執行 `npm start` 使用已建置的新介面。

## 設計資料表第二輪迭代（2026-09-27）

- Table／View 右鍵入口分別命名「設計資料表／設計檢視」，沿用既有分頁與資料草稿切換保護。
- 新增 `TableDesigner.tsx`：欄位清單選取、直接編輯名稱／型別／NULL／SQL 預設值、新增草稿列及刪除線標記。欄位支援方向鍵、Home／End，分類頁籤支援左右方向鍵。
- 主鍵使用獨立頁籤；新主鍵依勾選次序排列。既有 metadata 只含主鍵成員，不把欄位順序誤稱為原主鍵索引順序。
- 每次保留一項結構草稿；其他屬性暫停編輯並顯示原因。手動改回基準值會清除草稿及預覽。
- `StructureEditor` 保留共用 `structure.describe/preview/apply`、版本檢查及持久化草稿格式，舊草稿可直接恢復，無須遷移。SQL 預覽出現時移動焦點到預覽區，設計器工具列在捲動時固定。
- View 延續完整 SQL 編輯，成功訊息切換語言時會重新翻譯。

驗證：`npm run typecheck`、`npm run build` 通過；`npm test` 為 51 passed／10 skipped。`node scripts/smoke-ui-iteration.mjs` 通過，確認新入口仍保護既有資料草稿。最終 `node scripts/smoke-structure.mjs` 通過：右鍵設計資料表／設計檢視、鍵盤選取與分類切換、新增／型別／預設值／改名／刪除／主鍵、原值還原、草稿重新載入、DDL 失敗保護及 View 版本衝突。所有本輪修改程式與測試檔通過 Prettier 格式檢查。

截圖：`.local/table-designer.png`（深色設計器）、`.local/table-designer-light.png`（1280×720 淺色）、`.local/structure-editor.png`（View）。仍一次套用一項操作；批次結構變更與外鍵／約束整合設計未在本輪新增。沒有變更 adapter，也未重新封裝 `release/`。

## 全面 shadcn/ui Base UI 重構（2026-09-29）

已將 renderer 的按鈕、表單、勾選、下拉選單、型別自動完成、對話框、確認提示、操作選單、分頁、表格、通知與路徑整合到官方 shadcn/ui `base-nova` 元件。建立 Tailwind v4、共用色彩 tokens、`components.json` 與來源授權紀錄。保留 Monaco、TanStack 虛擬化、可調整欄寬和既有 GUI／MCP 命令邊界。

修正遷移中發現的方向屬性相容性、選單外部點擊、checkbox 無障礙名稱、欄位鍵盤導覽及導覽密度問題。完整盤點與決策見 [UI_REFACTOR.md](ui-refactor.md)。

驗證：production build／TypeScript 通過；一般測試 85 passed、29 skipped。Electron 完整桌面、連線生命週期、四類物件新增／修改／刪除／重新命名、資料表與 View 設計器、Redis 七類型、MCP 核准與取消、ASE 表單測試通過。檢查 1280×720 淺色及 1920×1080 深色畫面；加入設計器垂直排列、工具列高度與主題文字／背景色斷言。ASE 仍無真實伺服器可驗證；本次未重新封裝 release 安裝包。

## FUNCTIONS 清單第一批補齊（2026-09-29）

需求澄清：清單中的 TTL 原意為 **Heartbeat Interval（保持連線間隔）**。本批處理對照表編號 06、07、08、12、13；更新後為 28 已實作、11 部分實作、23 未實作。其他 Table／View／SQL 檔案缺口仍保留在 `FUNCTIONS_IMPLEMENTATION_MATRIX.md`，沒有將本批描述為清單全部完成。

- 連線表單加入 `connectionTimeout`（毫秒、預設 10000、範圍 100～300000）並傳入五類網路 adapter；SQL Server 包含 SQL／Windows 驗證的共用 pool 設定。ASE 另受操作期限限制，尚無 ASE 真實伺服器測試。
- 加入 `heartbeatInterval`（秒、預設 0 停用、上限 86400）。ConnectionService 在成功連線後按 scope 排程，不重疊執行；中斷、刪除或程式結束清除計時器，執行中的檢查沿既有操作排空機制完成。SQL pool 使用唯讀 SELECT 1；Redis 使用既有 client PING；ASE 探測 anchor，不另開查詢 session。失敗釋放整條邏輯連線並封鎖隱式重連，保留工作區草稿。此功能不保證保持 pool 中每一條實體連線。
- MySQL／MariaDB 用戶端 charset 可編輯、保存及傳入 mysql2 握手；空值沿用驅動預設。其他引擎不接受無效的 charset 參數。變更進階連線設定沿用既有未儲存工作保護，關閉舊連線後需手動重連。
- 共用 `database.options` 依目前伺服器讀取 MySQL／MariaDB 字元集與定序、SQL Server 定序。建立視窗支援選擇、搜尋、預設值；切換 charset 清除舊 collation。SQL Server 大量定序限制每次顯示 200 個符合結果，可搜尋其餘選項。
- 共用 `database.create` 增加 charset／collation 契約，保留 DDL 權限與核准的完整參數綁定。名稱採識別字引號，選項採嚴格 token 驗證與伺服器 catalog 比對；拒絕不存在、錯配或不支援引擎的選項。未指定選項時維持原先建立流程，不額外要求 catalog 查詢。
- 新增資料庫選項僅涵蓋建立，尚未補上既有 database 屬性修改、PostgreSQL encoding／locale。Read／Write Timeout 仍未實作，沒有以查詢逾時混充。

驗證：

- `npm run typecheck`、`npm run build` 通過。
- `npm test -- --maxWorkers=2`：93 passed、29 skipped；新增設定界線／相容預設、Heartbeat 啟停／失敗／不重疊／排空與 ASE anchor／Redis 禁止重連檢查。
- `npm run test:integration -- --maxWorkers=2`：36 passed，包含 PostgreSQL、MySQL、MariaDB、SQL Server 實際服務。新案例確認 MySQL／MariaDB session charset 為 latin1、建立後 SCHEMATA 字元集／定序正確、SQL Server sys.databases 定序正確，完成後刪除測試建立的資料庫。
- `node scripts/smoke-connection-options.mjs`：Electron 真實表單設定保存、引擎選項差異、定序搜尋／切換重置、MySQL／SQL Server 建庫及 Redis Heartbeat 生命週期通過。排版調整後再次驗證。新增可重跑指令 `npm run test:desktop:connection-options`。
- 畫面：`.local/connection-options.png`、`.local/database-options-mysql.png`、`.local/database-options-sqlserver.png`。未重新產生 release 安裝包。

方言依據：[MySQL Database Character Set and Collation](https://dev.mysql.com/doc/mysql/en/charset-database.html)、[Microsoft COLLATE](https://learn.microsoft.com/en-us/sql/t-sql/statements/collations?view=sql-server-ver17)。實際版本可用選項以伺服器 catalog 及上述整合測試為準。

## 外鍵與 CHECK 設計器（2026-09-29）

依 FUNCTIONS 清單補齊 Table 內容的外鍵（名稱、來源欄位、受參考 schema／table／columns、ON DELETE／ON UPDATE）與 CHECK（名稱、運算式、不強制執行）。對照表編號 35～44 更新為基本功能已實作；完整清單仍有 24 項部分實作／缺口，持續開發中。

- TableDesigner 新增「外部索引鍵」「檢查」頁，使用共用 shadcn 欄位／下拉／勾選／按鈕。外鍵提供有序多欄位配對、目標 schema／資料表／欄位清單；MySQL 的 schema 選單使用 database 清單，SQLite 限同一資料庫。
- 新增 `constraint-upsert`、`constraint-drop` 結構變更契約。沿用 `structure.describe/preview/apply`、Workspace 草稿、版本衝突檢查、MCP 權限與 SQL 預覽。修改及刪除約束採 destructive 風險等級，Agent 必須遵循每次核准流程。
- SQLite 從 CREATE TABLE 語法辨識具名／未命名、表級／行內 FK／CHECK；以既有交易重建機制保存資料、rowid、自動編號、索引與觸發器，提交前 foreign_key_check。違規資料／失敗 DDL 回滾整個重建。
- PostgreSQL、SQL Server 使用 system catalog；MySQL／MariaDB 使用 SHOW CREATE TABLE 與版本能力；ASE 使用 sysreferences／sysconstraints／syscomments，支援 16 欄位配對、僅 NO ACTION。ASE 沒有真實測試服務，仍是實驗性與模擬驅動驗證。
- MySQL 8.0.16+ 提供 NOT ENFORCED；SQL Server 以 WITH NOCHECK ADD／NOCHECK CONSTRAINT 停用 CHECK，重新啟用會驗證既有資料。MariaDB／SQLite／本批 PostgreSQL／ASE 不提供此選項。MySQL 不會對不支援外鍵的 MyISAM 表開放假功能。
- 特殊 MATCH、deferred、NOT VALID、複寫、跨資料庫 ASE 約束可辨識但保護其編輯，避免一般表單默默遺失特殊語意；仍可明確刪除。完整 SQL 管理持續可用。
- 真實服務測試發現 MySQL／MariaDB 同名外鍵 DROP／ADD 在單一 ALTER 會產生重名錯誤，因此同名修改使用分段 DDL；預覽明示未強制執行空窗並顯示原始復原 SQL。新增失敗時嘗試復原原始外鍵；復原亦失敗會明確回報，不能宣稱原子性。改名的替換沿用單一 ALTER。未使用 FOREIGN_KEY_CHECKS=0 省略資料驗證。

驗證：

- TypeScript、production build 通過；一般測試 98 passed／33 skipped。
- `npm run test:integration -- --maxWorkers=2`：45 passed，包含 SQLite、PostgreSQL、MySQL、MariaDB、SQL Server 約束 CRUD、違規資料拒絕、複合 FK 順序、CASCADE／SET NULL、NOT ENFORCED 與重新啟用、失敗復原與版本衝突。
- `node scripts/smoke-constraints.mjs` 通過：兩個頁籤、目標選擇、複合欄位配對、草稿 reload、preview/apply、修改／刪除、SQLite CHECK 失敗回滾與繁中切換。
- `node scripts/smoke-structure.mjs` 通過既有欄位／主鍵／View／草稿／資料重新載入流程。截圖 `.local/constraint-designer.png` 已視覺檢查。
- 可重跑桌面指令 `npm run test:desktop:constraints`。本輪沒有重新封裝安裝包。

方言依據：[SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)、[MariaDB CONSTRAINT](https://mariadb.com/docs/server/reference/sql-statements/data-definition/constraint)、[SAP ASE sysreferences](https://infocenter.sybase.com/help/topic/com.sybase.infocenter.dc36274.1570/html/tables/X18834.htm)、[SAP ASE 不支援 ON DELETE CASCADE](https://userapps.support.sap.com/sap/support/knowledge/en/2755827)。

## 欄位／資料表進階屬性（2026-09-30）

補齊 FUNCTIONS 編號 25、27～29、50～53，共 8 項。最新對照表為 46 已實作、11 部分實作、5 未實作，完整清單尚未完成。

- 設計器新增欄位選項及資料表選項頁籤，使用 Base UI／shadcn 元件。後端提供 `structure.options`，目錄選項、能力與變更契約為 GUI／MCP 共用；修改沿用 `structure.preview/apply`、版本檢查、草稿儲存、SQL 預覽和權限層。
- MySQL／MariaDB 支援欄位 charset／collation／binary／comment，表級 engine／預設 charset／collation／comment。MODIFY COLUMN 使用原始欄位宣告，只替換指定屬性，以保留型別、NULL、預設值及其他選項。表級預設修改不轉換既有欄位；畫面與 SQL 預覽明示此差異。
- PostgreSQL 使用 COMMENT ON 和 ALTER COLUMN TYPE COLLATE；SQL Server 註解使用 MS_Description，依存在狀態新增／修改／移除，變更定序時恢復欄位預設約束；特殊 generated 欄位定序不開放直接變更。SQLite 以交易重建修改 COLLATE，保留 rowid、資料與相依物件並驗證約束。
- 所有 charset／collation／engine 名稱驗證伺服器目錄。MariaDB UCA 的 COLLATIONS 目錄不總是包含 charset，改讀 COLLATION_CHARACTER_SET_APPLICABILITY 的 FULL_COLLATION_NAME；同時修正新建資料庫的定序目錄。引號、Unicode、反斜線依引擎字串規則處理。儲存引擎／字元屬性為 destructive，只有註解為 DDL。
- 不支援的原生選項不顯示；SQLite／ASE 無此批註解表單，ASE 尚未加入欄位定序。建立資料表表單先使用預設屬性，建立後從設計器調整。generated／Index／View 進階表單與其他清單缺口另行追蹤。

驗證：TypeScript 與 production build 通過；一般測試 102 passed／37 skipped；資料庫整合測試 52 passed（另新增的共享權限測試已在一般測試通過）。第一次整合測試找出 MariaDB UCA 問題並修正；一次 Windows 原生 worker 異常退出後，以單 worker 完整重跑全部通過。

`node scripts/smoke-structure-properties.mjs` 通過 MySQL 欄位／資料表選項、目錄篩選、binary、註解、草稿 reload、preview/apply、放棄及繁中切換；`.local/structure-properties.png` 已視覺檢查。既有 `node scripts/smoke-structure.mjs` 欄位／主鍵／View／工具列提示／草稿恢復完整回歸亦通過。整合測試服務已停止，未重新封裝安裝包。

方言參考：[MariaDB collation applicability](https://mariadb.com/docs/server/reference/system-tables/information-schema/information-schema-tables/information-schema-collation_character_set_applicability-table)、[MySQL ALTER TABLE](https://dev.mysql.com/doc/refman/8.4/en/alter-table.html)、[SQL Server extended properties](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-addextendedproperty-transact-sql?view=sql-server-ver15)。

## 產生欄位（2026-09-30）

FUNCTIONS 編號 23 已加入基本操作；對照表為 47 已實作、10 部分實作、5 未實作，完整目標持續進行。

- 新增 generation 模型，保存 expression、virtual／stored，與原本包括 identity／auto increment 的 generated 旗標分開。從 SQLite／MySQL 定義、PostgreSQL pg_attribute／pg_attrdef、SQL Server sys.computed_columns 讀取。
- 新建 Table 表單可以指定產生欄位；設計器新增專用頁面，可新增、修改運算式、選儲存方式及刪除。SQL Server 型別由運算式推導；表單清除不相容的預設值及主鍵，不接受另指定 NOT NULL。一般欄位不會被此流程直接覆寫成計算欄位。
- 共用 generation.options 提供版本能力；structure.preview／apply 新增 generated-add／generated-edit，經過 SQL 片段驗證、草稿持久化、樂觀版本檢查。新增為 DDL，修改為 destructive；GUI 和 MCP 使用同一權限與服務。
- SQLite 新增 Stored 與修改使用交易重建，保留原有資料、rowid、AUTOINCREMENT 高水位、索引與觸發器。新增宣告插入表級約束之前，避免 CREATE TABLE 的語法次序錯誤。運算式或相依唯一性失敗會回滾。
- MySQL／MariaDB 只替換原始 generated 子句，保留其他欄位屬性；既有儲存方式不以 drop/add 強制轉換。PostgreSQL 12+ 可建立 Stored、17+ 原生 SET EXPRESSION，18+ 提供 Virtual 建立；不直接修改既有 Virtual 或切換儲存方式。ASE 此功能尚未開放。
- SQL Server 改運算式採同交易 drop/add，保留 MS_Description；欄位位置移至末尾，在預覽說明。有自訂欄位權限／其他擴充屬性會拒絕，索引與約束相依由伺服器阻止。僅切換儲存方式使用 ADD／DROP PERSISTED。
- 資料 metadata 新增 generated 旗標；SQLite 使用 table_xinfo 顯示計算欄位。ResultGrid 計算值唯讀，新增列顯示「由資料庫計算」，共享 DataService 拒絕明確寫入計算值。一般欄位的 parameterized CRUD 仍由原路徑處理。

驗證：

- TypeScript 及 production build 通過。一般測試 106 passed／41 skipped；其後新增的共用權限／資料寫入防護測試納入整合測試通過。
- `npm run test:integration -- --maxWorkers=1` 最終 62 passed：包括 SQLite、PostgreSQL 17、MySQL 8.4、MariaDB 11.4、SQL Server 的建表／新增／修改／刪除、計算值、基礎資料更新、非法運算式回滾、SQL Server 註解保留及 metadata 唯讀辨識。PG 12／16／18 能力以版本模擬測試確認，未宣稱真實服務驗證。
- 一次建置與整合測試同時進行時出現 Windows 原生 worker 異常退出；等待原程序終止後，以單 worker 獨立重跑全套通過。早期測試找出的 MySQL metadata 別名保留字問題已改名並回歸。
- `node scripts/smoke-generated-columns.mjs` 通過新增／修改／刪除、Stored ↔ Virtual、草稿 reload、preview/apply、錯誤回滾、計算值唯讀、建表表單及繁中介面。`.local/generated-columns.png` 已視覺檢查。
- 整合服務停止，未重新封裝安裝包。

方言依據：[PostgreSQL 17 ALTER TABLE](https://www.postgresql.org/docs/17/sql-altertable.html)、[PostgreSQL 18 generated columns](https://www.postgresql.org/docs/18/ddl-generated-columns.html)、[MySQL generated column ALTER](https://dev.mysql.com/doc/refman/9.7/en/alter-table-generated-columns.html)、[SQL Server computed columns](https://learn.microsoft.com/en-us/sql/relational-databases/tables/specify-computed-columns-in-a-table?view=sql-server-ver17)。

## 2026-09-30：檢視進階選項（FUNCTIONS 56～59）

- 新增與修改 View 共用 ViewOptionsForm。MySQL／MariaDB 提供演算法、定義者帳號／主機、安全性及檢查選項；PostgreSQL 支援 LOCAL／CASCADED 與 15+ security_invoker；SQL Server／ASE 使用 WITH CHECK OPTION。SQLite／Redis 不顯示不適用設定。
- 主程序 `view.options` 回傳能力，`structure.describe` 讀取實際 metadata；`view-options` 草稿沿用 structure.preview／apply、版本衝突檢查、DDL 權限及 audit。GUI／MCP 走相同服務。建立 View 亦使用相同驗證與原生方言。
- PostgreSQL 使用 ALTER VIEW SET／RESET，保留 owner、其他 reloptions、註解及授權。MySQL 明確帶回既有 ALGORITHM／DEFINER／SQL SECURITY，CHECK OPTION 只在要求時變更，目標名稱固定為原 schema 與 view。SQL Server 保留 ANSI_NULLS／QUOTED_IDENTIFIER 前綴及原定義 body；indexed view 保持唯讀。
- SQL 定義與選項共用一份草稿；另一種編輯方式在待處理時鎖定，避免互相覆蓋。修改摘要仍在上方浮動提示，編輯方式提示固定占位，不因變更推動編輯區。表單及錯誤文字提供繁中翻譯。
- 定義者是否存在及權限、檢視是否可更新由伺服器驗證；TEMPTABLE 與 CHECK OPTION 不相容會在預覽拒絕。ASE 僅能力／語法測試，沒有真實服務驗收。

驗證：TypeScript、production build、一般測試 109 passed／45 skipped。整合測試原有案例及新解析案例共 64 passed；新增四個服務測試的 fixture 多傳入 schema，已修正並以 `npm run test:integration -- --maxWorkers=1 -t 'view options'` 重跑 5 passed。MySQL 8.4、MariaDB 11.4、PostgreSQL 17、SQL Server 均驗證建立、修改、讀回、CHECK OPTION 寫入阻擋、版本衝突及未更動屬性保留；PG／SQL Server 另驗證授權保留。

桌面 `scripts/smoke-view-options.mjs` 驗證新增、修改、明確定義者、錯誤保留、草稿 reload、SQL／選項互斥及繁中介面。最終重跑亦確認待處理變更前後 SQL 編輯區的垂直位置相同；`.local/view-options.png` 已視覺檢查。測試應用程式及本輪啟動的整合服務已關閉，未重新封裝安裝包。清單更新為 51 已實作、6 部分實作、5 未實作，完整補齊仍持續。

方言依據：[MySQL CREATE VIEW](https://dev.mysql.com/doc/refman/8.4/en/create-view.html)、[PostgreSQL ALTER VIEW](https://www.postgresql.org/docs/18/sql-alterview.html)、[SQL Server CREATE VIEW](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-view-transact-sql)、[SAP ASE create view](https://infocenter.sybase.com/help/topic/com.sybase.infocenter.dc36272.1600/doc/html/san1393050961648.html)。

## 2026-09-30：索引類型、方法與註解（FUNCTIONS 32～34）

- 新增及修改分頁共用 IndexOptionsForm，支援 NORMAL／UNIQUE，以及 MySQL／MariaDB 的 FULLTEXT／SPATIAL。MySQL 根據資料表引擎提供 BTREE／MEMORY HASH；PostgreSQL 從 pg_am 讀取方法與 can_unique／can_order；SQL Server／ASE 提供 CLUSTERED／NONCLUSTERED；SQLite 固定 BTREE。
- 原生索引註解支援建立、修改、清除與讀回：MySQL COMMENT、PG COMMENT ON INDEX、SQL Server MS_Description。PG／SQL Server 僅改註解不重建。長度限制在預覽驗證，字串保留引號、反斜線與中文；MySQL NO_BACKSLASH_ESCAPES 的詞法解析、單敘述檢查及重建 session 模式一致。
- 新增 index.options 讀取目標能力，object.preview／apply 接受 SQL 或 indexOptions 二擇一；GUI／MCP 共用版本檢查、DDL policy、audit 及事件。草稿保存於既有 workspace；原始 SQL 與表單互斥，切換前先套用／還原。
- 修改只替換索引 header／指定選項，保留鍵、expressions、INCLUDE、predicate、儲存參數等宣告。相依約束／方法不相容由資料庫拒絕，不隱含刪除相依物件。主鍵與特殊索引保留既有管理界線。
- 實測修正 SQL Server 原生差異：聚集轉非聚集不接受 DROP_EXISTING，改為同一交易內 DROP／CREATE；切換索引 id 可能移除擴充屬性，因此原生及表單修改都恢復 MS_Description。包含其他自訂擴充屬性的索引顯示唯讀原因；測試確認拒絕操作，避免遺失。
- 例行測試另外發現本機 Windows 動態 TCP 範圍從 1024 開始，偶爾分配 Fetch 禁用的埠，造成 MCP fixture 的 `bad port`。測試改用 30000～49999 並重試占用，未變更系統網路設定或 MCP 產品行為。

驗證：

- `npm run typecheck`、production build 通過；`npm test -- --maxWorkers=1 --no-isolate`：112 passed、49 skipped。
- 完整 `npm run test:integration -- --maxWorkers=1 --no-isolate`：75 passed。涵蓋 SQLite、PG 17、MySQL 8.4、MariaDB 11.4、SQL Server；驗證唯一性、UNIQUE 衝突保留原索引、方法切換、註解清除、版本衝突，以及 GIN／FULLTEXT／SPATIAL／MEMORY HASH。追加 NO_BACKSLASH_ESCAPES 引號／反斜線註解後，索引案例再次通過五種服務測試。ASE 僅語法模擬。
- 原本每檔建立 fork 的執行曾出現 Windows worker 3221226505；確認舊程序終止後，以單 worker 並關閉檔案隔離跑完整套件通過，沒有略過失敗檔案。
- `node scripts/smoke-index-options.mjs` 通過建立、FULLTEXT 轉 NORMAL、方法／註解編輯、UNIQUE 衝突、草稿 reload、SQL／選項互斥及繁中介面。視覺檢查另調整註解標籤為上方對齊，重建並重跑桌面流程通過；最終截圖 `.local/index-options.png` 已檢查。測試程式與整合服務已停止，未重新封裝安裝包。
- 功能清單更新為 54 已實作、3 部分實作、5 未實作；尚未將全部目標標記完成。

方言依據：[MySQL CREATE INDEX](https://dev.mysql.com/doc/refman/8.4/en/create-index.html)、[PostgreSQL access method properties](https://www.postgresql.org/docs/16/functions-info.html)、[SQL Server extended properties](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-addextendedproperty-transact-sql)、[SQLite CREATE INDEX](https://www.sqlite.org/lang_createindex.html)、[ASE create index](https://help.sap.com/docs/SAP_ASE/4c45f8d627434bb19e10dd0abbb757b0/ab0914e2bc2b101489dfed754b9acfd8.html)。

## 2026-09-30：資料庫字元集與定序（FUNCTIONS 12～13）

- PostgreSQL 建立資料庫新增 encoding、locale、LC_CTYPE 與版本對應的 locale provider：15+ libc／ICU、17+ builtin。從伺服器 catalog 提供選項，locale 可輸入伺服器支援的名稱；builtin 驗證清單、ICU 檢查 UTF8。指定選項使用 template0，未指定時維持既有 CREATE DATABASE 行為；PG 14 以前不顯示不支援的 LOCALE_PROVIDER。
- 資料庫名稱選單新增「資料庫屬性」，可查看目前編碼／定序及原生能力。MySQL／MariaDB 可改預設 charset／collation，SQL Server 使用者資料庫可改 collation；PostgreSQL 與 SQLite 既有編碼唯讀，ASE 說明其設定屬於伺服器整體。SQL Server 系統資料庫不提供修改。
- GUI／MCP 共用 database.properties.describe／preview／apply；變更先預覽 SQL，套用時使用 destructive 權限、版本檢查、同連線與資料庫的寫入互斥及變更事件。MySQL charset／collation 必須匹配伺服器選項，單獨改 charset 時讓伺服器選預設定序；既有欄位不隨資料庫預設值轉換。
- SQL Server 由 master 執行 ALTER DATABASE，先暫停並釋放本程式的目標資料庫連線池，再重新驗證屬性版本。暫停期間拒絕新操作、等待已送出操作完成，旧 handle 永久失效；完成或失敗後允許重新建立該 scope。關閉整條連線／程式時也會等候正在釋放的 scope，防止背景 DDL 或遺留連線。不使用 SINGLE_USER、KILL 或強制回滾其他用戶端。
- 補上繁中屬性介面與「預覽 SQL」翻譯。隱藏視窗 smoke 截圖停用動畫，避免 compositor 暫停造成選單退場殘影；產品介面動畫維持原設定。

驗證：TypeScript 與 production build 通過。完整一般測試 116 passed／53 skipped；追加 SQLite 編碼唯讀案例後，database-properties 檔另跑 2 passed／4 skipped。完整整合測試 80 passed；新增 SQL Server 定序造成物件名稱衝突的失敗／資料保留案例，以及最後的連線釋放修正後，再跑四個資料庫服務案例通過。中間一次 Windows fork 出現 3221226505，確認命令結束後重跑成功，未略過失敗項目。

`scripts/smoke-database-properties.mjs` 驗證 MySQL／SQL Server 屬性預覽及套用、PG ICU 建庫、唯讀能力與中文顯示；最終 build 後重跑通過，`.local/database-properties.png` 及 `.local/database-postgres-locale.png` 已視覺檢查。測試專用資料庫、應用程式與整合服務已清理／停止，未重啟使用者原有 dev 程式，未重新封裝安裝包。清單更新為 56 已實作、1 部分實作、5 未實作，完整目標仍持續。

方言依據：[PostgreSQL CREATE DATABASE](https://www.postgresql.org/docs/17/sql-createdatabase.html)、[MySQL database character set and collation](https://dev.mysql.com/doc/mysql/en/charset-database.html)、[SQL Server database collation](https://learn.microsoft.com/en-us/sql/relational-databases/collations/set-or-change-the-database-collation)、[SAP ASE sort order](https://help.sap.com/docs/SAP_ASE/e0d4539d39c34f52ae9ef822c2060077/ab39dc2fbc2b1014abaca21210aced04.html)。

## 2026-09-30：SQL 檔案執行（FUNCTIONS 14）

- 資料庫選單新增「執行 SQL 檔案」，原生選檔後由主程序讀取 UTF-8／BOM UTF-16，檢查 16 MiB 上限及非法編碼。GUI 顯示行號／批次預覽、進度、最近 200 筆結果、遇錯停止／繼續及取消。檔案不會自動重試，未將一般查詢的單句邊界放寬。
- 共用 script.preview／execute／status／cancel，native file.sql.open 僅開放桌面；agent 傳文字，不能要求任意路徑讀取。整份檔案使用 destructive 核准，再檢查各敘述風險；未知批次要求全部寫入政策。新增 CommandBus additionalRisks 與可摘要的稽核參數，避免大型檔案反覆落盤。每個 run 綁定 actor、目標及連線設定；只有原 actor 或桌面可取得／取消工作。
- 每份檔案使用專屬固定 session，保留交易、暫存表及 SET。MySQL／PG 取用原生專屬 client 並在結束時銷毀；SQL Server 用專屬單連線 pool 與 batch API；ASE 用專屬原生 session。SQLite 使用獨立子程序，以便取消同步原生呼叫並等待檔案鎖釋放；不把「只停止等待」誤報為原生查詢已停止。
- 分段涵蓋 MySQL DELIMITER、可執行註解、SQL_MODE 的常值／保存還原與 ANSI_QUOTES；PG dollar quote、E 字串、BEGIN ATOMIC；SQL Server／ASE GO 及重複次數；SQLite trigger 的 `; END;` 邊界，不把欄位名 end／begin 當成區塊結束。未閉合語法及不支援的客戶端指令在送出 SQL 前拒絕；MySQL 動態 SQL_MODE、PG COPY FROM STDIN／非標準字串模式的限制已寫入 README。
- 每批沿用 queryTimeout；取消／逾時／連線關閉後不送出下一批。各引擎保留自身提交語義，尚未提交交易在 session 關閉時回滾。SQL Server 的串流 error 事件會使該批失敗，不能僅依 Promise resolved 判定成功。大檔案風險分析定期讓出主程序事件迴圈；工作結果及稽核有明確數量界線。

驗證：完整一般測試 122 passed／57 skipped；完整真實整合測試 89 passed。涵蓋 SQLite、PG 17、MySQL 8.4、MariaDB 11.4、SQL Server 的交易、暫存表、程序／trigger、遇錯停止／繼續、未提交回滾、取消後不繼續寫入、3 秒內取消完成，以及中斷連線後禁止背景重連。ASE 專屬 session 及失敗釋放由模擬驅動驗證。最後增加 source／delimiter 欄位名稱解析案例，sql-script 單檔再次通過 4 passed／4 skipped。

TypeScript／production build 通過；`scripts/smoke-sql-file.mjs` 通過桌面選檔讀取、預覽、交易匯入、遇錯繼續、取消與繁中畫面，僅 stub OS 檔案選擇結果，實際主程序讀檔／IPC／命令與資料庫均執行。`.local/sql-file-execution.png` 已檢查並修正結果欄標題、左對齊及進度條樣式。失敗測試遺留的四個專用 procedure 已核對名稱／內容並清除。清單更新為 57 已實作、1 部分實作、4 未實作；SQL 匯出及連線其餘選項仍在進行。

## 2026-09-30：SQLite SQL 匯出（FUNCTIONS 15～16，跨引擎仍未完成）

- SQLite 資料庫選單新增「匯出 SQL 檔案」，支援結構和資料／只有結構、大小與資料列統計、取消、原生儲存，以及繁中／英文介面。沿用匯入的 16 MiB／50000 批次限制；超限與不支援物件會明確失敗，不留下可誤用的半成品。
- GUI／MCP 共用 export.start／status／read／cancel／release，擁有者及目前連線權限／設定逐次檢查。原生 file.sql.save-export 僅供桌面選檔，沒有任意檔案路徑的 agent 命令；完成後以 64 KiB base64 區塊供原 actor 讀取。取消／清除不依賴仍持有資料讀取權，避免連線刪除或權限撤銷後無法清理暫存。
- SQLite 使用獨立唯讀子程序及單一交易快照，逐批 ACK 控制寫入速度。DDL 直接取自 sqlite_schema；資料在 SQLite 端序列化，避免 JS Number 或 UTF-8 解碼造成精度／二進位損失。保留編碼、user_version、application_id、hidden rowid、自動編號高水位及 Virtual／Stored 產生欄位；資料之後建立 Index／View／Trigger，避免觸發器重複產生副作用。
- 不支援虛擬／shadow table，或所有 rowid 別名都被遮蔽的資料表。其他 SQL 引擎尚未開放匯出；不將此輪驗證擴大宣稱為全引擎完成。儲存先複製到目的目錄的唯一暫存檔，再原子替換，拒絕覆蓋已設定的 SQLite 檔案；關閉視窗或正常結束應用程式會清理暫存。

驗證：完整一般測試 126 passed／57 skipped；新 sql-export 測試 4 passed，涵蓋 UTF-8／UTF-16、Unicode／NUL、整數邊界、BLOB、浮點數與正負無限值、rowid、外鍵、索引／檢視／觸發器、序號高水位、WAL 同時寫入的一致性、取消、權限／擁有者、16 MiB 上限及刪除連線後的清理。TypeScript／production build 通過；scripts/smoke-sql-export.mjs 驗證兩種模式、真實儲存流程、繁中介面與透過 SQL 檔案執行還原，只有 OS picker 回傳值被 stub。`.local/sql-file-export.png` 已視覺檢查，資料列標題補齊繁中翻譯。沒有更動使用者原有 Electron 程式，也未重新封裝安裝包。

清單維持 57 已實作，改為 3 部分實作、2 未實作，共 5 項待完整補齊：其他引擎 SQL 匯出、用戶端字元集，以及真正的 Read／Write Timeout。

最終建置後再次通過桌面 smoke；匯出回歸補驗中斷連線取消且不重連，以及權限撤銷／刪除連線後仍可 release。匯出暫存目錄已確認清空，測試應用程式與整合服務已停止。

## 2026-09-30：MySQL／MariaDB SQL 匯出（FUNCTIONS 15～16 持續補齊）

- 將現有共用匯出服務與桌面入口擴充至 MySQL／MariaDB，包含結構和資料／只有結構、取消、原生儲存及繁中說明。SHOW CREATE 收集資料表（含索引／約束）、檢視、觸發器、函式及預存程序；保留原始 DEFINER、SQL_MODE、connection collation、AUTO_INCREMENT。不改寫資料庫參照，要求還原至原名稱／定序的空白資料庫；不包含 events、使用者授權或伺服器設定，帳號必須可讀取所有預期物件的 metadata。
- InnoDB 使用 REPEATABLE READ／READ ONLY 一致性快照，取用各物件的 metadata lock；混合 MyISAM／Aria／MEMORY／CSV／ARCHIVE 時改用 autocommit=0、session READ ONLY 及 LOCK TABLES READ，以保證跨表內容一致。UI 說明期間會暫停寫入與所需權限；取消及完成會釋放專屬連線／鎖。MariaDB system-versioned／sequence 與遠端／未知引擎明確拒絕資料匯出。
- 值在伺服器端產生 SQL literal，保留 DECIMAL(65,25)、unsigned BIGINT、FLOAT／DOUBLE、BIT、ENUM／SET、BLOB、JSON、空間 WKB／SRID、日期時間微秒，以及 MariaDB UUID／INET4／INET6。各欄字元集單獨保留，產生欄位排除於 INSERT。超大值受 max_allowed_packet 影響而序列化為 NULL 時明確失敗，不輸出失真的資料。
- View 相依辨識只採 FROM／JOIN 的物件位置，排除欄位別名、函式、外部 schema 與 CTE bindings；有序建立 View，資料之後再依 ACTION_ORDER 建立觸發器。匯出末端結束資料快照後再查 live catalog，避免 MySQL 8 的 transactional dictionary 掩蓋期間新增的物件；結構變更時拒絕完成，單純 AUTO_INCREMENT 前進不誤判為 DDL。
- SQL 檔案執行改為獨立 UTF-8 MySQL session，避免既有 latin1 連線把 Unicode 檔案文字替換；一般查詢仍依使用者設定的 charset。原有 script session 的交易／取消／錯誤停止功能回歸通過。

驗證：一般測試 127 passed／59 skipped；完整真實整合測試 92 passed。後續新增 READ 鎖、取消釋放、CTE／字元集、特殊名稱及 UUID／INET 案例後，MySQL 8.4／MariaDB 11.4 專項再次 2 passed。測試實際重建自己的隨機測試資料庫並匯入，核對精確值、View／routine 執行、觸發器順序、序號高水位，以及寫入等待與 snapshot 不混入新資料。UUID 初版 fixture 使用無效版本位元、在原庫就成為 NULL；已修正為有效 UUID 並先斷言原值，避免將無效 fixture 當成匯出缺陷。

TypeScript／production build 通過；`scripts/smoke-mysql-export.mjs` 通過兩個引擎的原生儲存、16 MiB／伺服器限制錯誤後切換結構模式、UTF-8 重新匯入、中文畫面。`.local/mysql-sql-export.png` 已視覺檢查。新命令 `npm run test:desktop:mysql-export`，需先啟動整合服務。清單仍為 57 已實作、3 部分實作、2 未實作；PG／SQL Server／ASE 匯出及連線進階缺口持續進行。

方言依據：[MySQL LOCK TABLES](https://dev.mysql.com/doc/refman/8.0/en/lock-tables.html)、[MariaDB LOCK TABLES](https://mariadb.com/docs/server/reference/sql-statements/transactions/lock-tables)、[MySQL SQL modes](https://dev.mysql.com/doc/refman/8.0/en/sql-mode.html)、[SHOW CREATE TRIGGER](https://dev.mysql.com/doc/refman/9.7/en/show-create-trigger.html)。

## 2026-09-30：PostgreSQL 原生 SQL 匯出（FUNCTIONS 15～16 持續補齊）

- PostgreSQL 資料庫選單提供結構和資料／只有結構匯出，沿用共用 Application Command Bus、權限、工作擁有者、取消、16 MiB／50000 批次限制及原生儲存。使用已安裝的 pg_dump，優先 PATH，再搜尋標準安裝目錄；連線表單可指定絕對路徑。變更路徑會使舊 adapter 失效，避免新設定仍使用舊工具；缺少工具會明確報錯。
- 以受控子程序執行原生 snapshot 備份，包含 schema／enum／domain／複合型別、序號、分割表、產生欄位、索引／約束、View／Materialized View、函式、Trigger、ACL／RLS、extension 定義與大型物件。保留原生相依順序及 OWNER 等參照，目標須具備角色、擴充套件、資料表空間與權限；不包含角色建立、資料庫建立／預設屬性、publication／subscription、foreign table 遠端資料。Materialized View／序號依原生工具語義還原，並非所有非交易狀態都與資料快照完全同步。
- 產生 UTF-8 INSERT SQL，避免 COPY FROM STDIN 的客戶端協定。pg_dump 18 的 psql restriction markers 以每次不可預測 nonce 精確識別，只移除該兩行；沒有放寬匯入器對任意 psql／shell 指令的拒絕。密碼透過子程序環境傳遞，不出現在 argv；清除繼承的 PG service/options/password 變數，以跳脫過的 conninfo 固定目的地；TLS 使用 verify-full。子程序無 shell、Windows 隱藏視窗，串流保留背壓，取消／逾時／寫檔失敗會終止並等待工具退出。
- 真實往返找出 Windows pg_dump stdout 的 CRT 換行轉換會讓文字中的 CRLF 變 CRCRLF；在 native transport 邊界逆轉一次後儲存。SQL 分段器取消全域 CRLF 正規化，保留 literal／dollar body 原始內容，GO／DELIMITER 的 CRLF 行號仍通過回歸。pg_dump 的 INSERT 模式進度訊息是 processing data for table，已同時辨識此格式與舊訊息，資料表計數採建立 TABLE，排除 TABLE ATTACH；資料列數以 null／「—」表示未知。

驗證：Windows 已安裝 pg_dump 18.0 對 PostgreSQL 17.11 實際重建隨機測試資料庫並由本 App parser／固定 session 匯入；核對 NUMERIC(40,20)、Unicode／LF／CRLF、bytea、陣列、JSONB、UUID、interval、timestamptz、hstore、序號高水位、觸發器副作用、分割表、ACL／RLS、Materialized View 及 large object。取消等待鎖的匯出在 3 秒內返回，pg_stat_activity 確認原生 backend 消失；只有結構模式沒有資料。測試資料庫自行清理。

完整一般測試 129 passed／60 skipped，完整整合測試 95 passed。追加進度計數斷言後 PostgreSQL 專項再次通過；追加工具路徑的連線生命週期測試後，connection-options／postgres-export 非整合專項 10 passed／1 skipped。TypeScript 與 production build 通過。跨引擎總表維持 57 已實作、3 部分實作、2 未實作；SQL Server／ASE 匯出、其他引擎用戶端字元集及 Read／Write Timeout 仍需補齊。

原生工具行為參考：[PostgreSQL pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)。建議使用與伺服器同主要版本的最新版 client，較新版工具產生的 SQL 並不保證可還原至舊版伺服器。

最終建置後，`scripts/smoke-postgres-export.mjs` 通過桌面工具路徑保存／錯誤／清空恢復自動偵測、變更路徑斷線、兩種匯出模式、原生儲存、共用 script.preview／execute 重新匯入、精確 CRLF 與中文畫面。只有 OS 檔案 picker 回傳值被 stub，其餘資料庫、子程序、IPC 與檔案寫入實際執行；`.local/postgres-sql-export.png` 已視覺檢查，資料表顯示 1、資料列顯示「—」。新增命令 `npm run test:desktop:postgres-export`。專用測試資料庫與匯出暫存目錄已確認清空，測試 App 已關閉；沒有重新啟動使用者原有 dev 程式或重新封裝安裝包。

## 2026-09-30：SQL Server 原生結構／資料匯出（FUNCTIONS 15～16 持續補齊）

- SQL Server 資料庫選單新增兩種 SQL 匯出模式，沿用共用 Command Bus、權限、actor 隔離、進度、取消、16 MiB／50000 批次限制與原生儲存。連線可指定 PowerShell 路徑，更新路徑會關閉舊 adapter；工具缺失或模組不相容有明確錯誤。需 SQL Server 2017+，已驗證 SQL Server 2022、Windows PowerShell 5.1／SQLPS／SMO 16。
- 以 SMO 產生 schema、型別、資料表／索引／約束、檢視、函式／預存程序、觸發器、序號、分割配置、synonym、full-text、security policy 與物件授權／擴充屬性。不包含建庫、資料庫預設設定、角色／使用者建立及 CLR assembly 本身；還原須先備妥所需外部相依，詳見 README。資料匯出期間應避免 DDL，結束前 sys.objects 版本比對不保證涵蓋所有 metadata 變更。
- 全部使用者資料表的共享鎖持有至匯出結束，期間阻擋寫入；資料使用同一專屬交易讀取。值由伺服器序列化，避開 JS double、Windows 原生驅動小數及用戶端空間 CLR 限制。保留 NUMERIC(38,18)、浮點 roundtrip、Unicode／NUL／LF／CRLF、BLOB、datetime2／datetimeoffset／time(7)、XML、geometry／geography、hierarchyid、GUID 與 SQL_VARIANT。非 Unicode 文字以原始位元組寫入原定序欄位，TEXT／SQL_VARIANT 使用具明確型別及定序的 staging table variable，避免跨字碼頁損壞。
- 資料後才建立 FK／CHECK／Trigger，保留原停用／未信任狀態，避免匯入觸發器重複副作用。計算欄位及 rowversion 重新產生。明確還原 identity 下一值，包含使用後清空與尚未使用的 reseed 差異；sequence 在目的端重建位置而不更改 START WITH，測試涵蓋循環及已耗盡序號。序號狀態獨立擷取，不宣稱與表資料完全同時。
- 必須有全資料庫 VIEW DEFINITION；遮罩欄位需 UNMASK，啟用 RLS／Always Encrypted／temporal／ledger 資料拒絕資料模式，可使用結構模式。無法序列化的資料或超限工作不提供半成品。工具接收固定內建腳本及獨立 JSON stdin 參數，憑證不放命令列或檔案；SqlConnectionStringBuilder 防止連線參數注入。分塊 ACK 保持背壓，取消／閒置逾時／寫檔失敗終止子程序並等待退出。

驗證：一般測試 **131 passed／62 skipped**；完整 Docker 整合 **97 passed／1 skipped**；另以 `TEST_WINDOWS_SQLSERVER=1` 通過 Windows 身分的 SQL Server 專項。兩種登入皆實際匯出／重建隨機資料庫／經 App parser 與固定 session 匯入，再比較精確值、字碼頁、括號識別字、觸發器副作用、identity／sequence。驗證共享鎖阻擋並行寫入、取消後原生 SQL session 消失、RLS 資料模式拒絕而結構模式可用。Windows 測試的 msnodesqlv8 ODBC 池會保留閒置 session，測試只針對自身隨機資料庫清理，未將此誤認為匯出子程序洩漏。

TypeScript 與 production build 通過；`scripts/smoke-sqlserver-export.mjs` 通過工具路徑錯誤／清空、設定變更斷線、兩種模式、原生儲存及 Command Bus 重新匯入，`.local/sqlserver-sql-export.png` 已視覺檢查。新增命令 `npm run test:desktop:sqlserver-export`。清單維持 **57 已實作、3 部分實作、2 未實作**；ASE 匯出、其餘用戶端字元集及 Read／Write Timeout 仍待補齊。

## 2026-09-30：MySQL／MariaDB 獨立網路讀寫逾時（FUNCTIONS 09～10）

- 連線新增 Read timeout／Write timeout（毫秒，0 停用，最大 300000），持久保存、共用 schema 驗證與 adapter 失效處理。舊設定未指定視同 0，變更設定需重新連線；其他網路引擎尚未接上，表單不顯示無效選項，API 亦拒絕非零設定。本批將 09～10 從未實作改為部分實作，清單為 **57 已實作、5 部分實作、0 未實作**，仍有 5 項未完整完成。
- 共用 SocketTimeouts 追蹤實體 transport 接收資料及 pending write callback。Read timeout 每次收到資料重設，僅在等待結果時啟用；本機背壓暫停讀取、閒置與已完成查詢不計時。Write timeout 限制仍有待完成寫入時沒有 callback 完成的間隔，不以 SQL 寫入命令的總時間代替。毀棄 socket 時清除計時器／監聽器／包裝方法；不重送失敗 SQL，既有 Query／Connection timeout 保留獨立職責。
- mysql2 的池連線、SQL 檔案專屬連線及匯出連線使用同一處理，登入後從目前 stream 取得 socket／TLSSocket。啟用 I/O 期限時，同時將 Connection 層的網路錯誤傳給事件式 Query，避免原生連線已失敗，Promise 卻等到查詢總期限才返回。callback／Promise 查詢仍沿用驅動的原錯誤路徑。
- 各網路引擎的連線表單顯示可調整字元集或唯讀編碼與原因。現有 pg-protocol 讀寫硬編碼 UTF-8、SQL Server 依 Unicode／欄位定序、Redis 工作區採 UTF-8，尚未以可選欄位冒充支援。依 SAP ODBC 文件修正 ASE 的 CharSet 轉換模式與 ClientCharset 分工：ClientDefault／Other，Windows 用 UTF-8 code page 65001，其他平台 utf8。ASE 僅有回歸與模擬驅動驗證，真機限制保持不變。

驗證：一般回歸 **139 passed／64 skipped**；標準檔案隔離的完整整合測試 **105 passed／1 skipped**；TypeScript 檢查通過。新增測試包含真實 TCP 多次分塊收取、超過讀取期限的連續傳輸不誤判、閒置／release、暫停消費、阻塞寫入、經憑證驗證的 TLS 收發逾時。MySQL 8.4／MariaDB 11.4 實測 SLEEP 回應逾時、socket cork 待送寫入、後續查詢可用、SQL 檔案及等候表鎖的匯出逾時。Windows loopback 會立即接受大型 send buffer，故 write case 以實體 socket cork 穩定製造未完成 callback，而不把 payload 大小當作已阻塞的證據。

`scripts/smoke-connection-options.mjs` 通過逾時設定保存、共用 query.execute 實際錯誤回報、SQL Server 唯讀編碼、資料庫選項與 Redis Heartbeat；`.local/connection-io-timeouts.png` 已檢視。非隔離模式（`--no-isolate`）完整套件曾出現 Windows worker exit 3221226505，移除新增 I/O 測試仍重現；原因尚未確認，未當作成功。標準隔離模式完整通過，保留此診斷紀錄。

最終 TypeScript／production build 通過。測試 App 已關閉；確認 PostgreSQL 中斷測試留下的隨機資料表與函式符合本專案 fixture 後，已按確切名稱清理，其他本輪專用測試資料庫已清空。整合服務已停止，使用者原有開發程式保持原狀。

## 2026-09-30：PostgreSQL 網路讀寫逾時（FUNCTIONS 09～10 持續補齊）

- PostgreSQL 連線表單提供持久保存的 Read／Write timeout（毫秒、0 停用），沿用共用 schema、Command Bus 與連線設定失效處理。其他未實作引擎仍拒絕非零設定。
- 在池實體連線完成登入後套用 SocketTimeouts，使用登入後的 socket／TLS stream。期限從實際 Query／Parse／Bind 開始，到 ReadyForQuery 結束；不把池閒置或 client 佇列等待當成網路等待。先於 pg 的 ReadyForQuery 處理器釋放前一期限，避免下一查詢已派送後被前一查詢的清理取消計時；快取預備語句直接 Bind 也有涵蓋。
- 收到資料（含 PostgreSQL NOTICE）重設讀取期限，pending write callback 完成重設寫入期限。checked-out Client 的 transport error 有監聽器，原生驅動仍將錯誤傳至查詢；逾時後不重試 SQL，後續查詢可取得新的連線。
- 一般查詢、metadata、DDL 與 SQL 檔案 session 適用。原生 pg_dump 的 transport 尚未接上，使用既有獨立匯出期限；設定畫面與 README 明示此限制，沒有將 SQL 匯出宣稱為已支援此連線參數。總表仍為 **57 已實作、5 部分實作、0 未實作**。

驗證：PostgreSQL 17.11 實測長於 deadline 的持續 NOTICE、SLEEP 讀取逾時、真正 socket cork 阻塞寫入、錯誤後新查詢、SQL 錯誤後閒置、快取預備語句、排隊六個查詢、DDL 及 SQL 檔案。建置與 TypeScript 通過；桌面 smoke 通過 PostgreSQL 設定保存、固定 IPC 的實際逾時回報及繁中提示，`.local/postgres-io-timeouts.png` 已視覺檢查。

本輪 Node 24.15.0 下，預設檔案隔離的一般測試在 MCP、整合測試在 constraints 出現 worker exit 3221226505；MCP 單檔 6 項重跑通過。故先前「非隔離」紀錄不能解讀為問題只限該模式。另從 nodejs.org 下載 Node 24.21.0 至忽略版控的 `.local/node-v24.21.0-win-x64/node.exe`，比對官方 SHASUMS256 後做版本對照；沒有修改系統 Node 安裝。該版本完整一般測試 **139 passed／65 skipped**。未取得原生 crash stack，不能只憑退出碼或新版本通過宣稱根因已確定。

Node 24.21.0 的完整整合測試亦 **106 passed／1 skipped**（15 個檔案全部完成）。兩套測試均使用預設檔案隔離、單一 worker；未改測試斷言或忽略失敗。桌面測試 App 已結束；本輪新增 PostgreSQL I/O 測試不建立持久物件，資料庫清查沒有本輪留下的新表，既有舊測試資料保持原狀。

## 2026-09-30：SQL Server 帳密模式網路讀寫逾時（FUNCTIONS 09～10 持續補齊）

- SQL Server SQL 帳密驗證新增可保存的 Read／Write timeout，沿用 schema、Command Bus 與連線設定失效處理。Windows 驗證會隱藏這兩個選項，儲存時清為 0；API 拒絕 Windows ODBC 模式的非零期限，避免設定無效但被誤認為已套用。
- 使用 mssql 的 beforeConnect 入口，在登入成功後替單一 Tedious 20 實體連線加入 request 生命週期處理。所有 makeRequest（包含查詢、batch、交易開始／提交／回滾）在實際派送時啟用 socket guard，在呼叫原始完成 callback 前釋放；錯誤／關閉與同步拋錯也清理。沒有全域修改驅動原型，也不重送失敗 SQL。
- 使用實際網路 socket 的接收與 pending write callback 計時。TDS 7.x TLS 的內部明文雙工串流不等於 TCP 送出完成，因此使用登入完成後的實體 transport；握手仍由 Connection timeout 管理。共用 SocketTimeouts 增加可重入的讀取暫停／恢復，Tedious Request 暫停消費結果時不誤判逾時，寫入期限保持獨立。
- 範圍含一般查詢／metadata、DDL 與 SQL 檔案。Windows ODBC 與原生 SMO／PowerShell 匯出的 transport 仍待接上，匯出沿用自身工作期限；設定畫面與 README 明示限制。總表維持 **57 已實作、5 部分實作、0 未實作**。

SQL Server 2022 實測：閒置超過 read timeout 後查詢正常、持續 RAISERROR WITH NOWAIT 輸出使長查詢不誤判、WAITFOR 觸發讀取期限、實體 socket cork 觸發寫入期限、暫停消費 500ms 後讀取已緩衝的第二個結果、SQL 錯誤與網路錯誤後的後續查詢，以及 DDL／SQL 檔案的期限。測試不建立持久 SQL Server 資料。共用 guard 另驗證多層讀取暫停與重複恢復不會提前重啟期限。

TypeScript／production build 通過；Node 24.21.0 的完整一般測試 **140 passed／66 skipped**。驅動入口參考 [node-mssql beforeConnect](https://github.com/tediousjs/node-mssql#tedious)，內部 makeRequest 相容處理沿用專案固定的 Tedious 20.0.0，升級時須重跑實機 I/O 案例。

完整資料庫整合測試 **108 passed／1 skipped**（15 檔），桌面 smoke 通過 SQL Server 帳密模式的期限保存、Windows／SQL 驗證切換的欄位顯示、固定 IPC 的 WAITFOR 實際逾時，以及繁中畫面的原生匯出限制提示。`.local/sqlserver-io-timeouts.png` 已視覺檢查；原有 MySQL／PostgreSQL 期限與 Redis Heartbeat 桌面流程亦通過。測試 App 已關閉，桌面建立的專用資料庫由 finally 清理。

## 2026-09-30：Redis 網路讀寫逾時與連線初始化（FUNCTIONS 09～10 持續補齊）

- Redis 連線表單新增持久保存的 Read／Write timeout（毫秒、0 停用），共用 schema／權限／Command Bus 與連線失效處理。所有 Redis 工作區命令、資料庫摘要及 Heartbeat 都由同一個 adapter command 路徑套用 socket deadline，TCP／TLS 皆適用。
- Redis 驅動沒有公開實體 socket，因此使用 Node `net.client.socket` 通知與 AsyncLocalStorage，辨識本次連線嘗試建立的唯一活躍 socket。訂閱僅存在於連線嘗試期間，成功／失敗都移除；不改寫全域 net／tls factory，也不讀寫驅動的私有欄位。該內建通知仍為 experimental；缺少／不唯一時明確拒絕啟用逾時的連線，不靜默忽略。Node／Electron 升級需跑對應測試。
- 多個同步要求建立連線的操作共用一個 Promise，避免重複開啟遺留連線；已發出 ready 但 open 尚未完成時，命令仍等待 guard 安裝後才執行。Connection timeout 現在也涵蓋 AUTH／SELECT／初始化回應，主動關閉可取消正在建立的連線。Read／Write 仍只從一般命令開始計時，與登入／整體命令期限分工。
- 接收任何回應分塊會重設 read deadline，待完成寫入依實際 socket callback 計時。網路失敗沿用驅動的拒絕路徑；保留 disableOfflineQueue 與 reconnectStrategy=false，不自動重送已發出的命令。

驗證：新增非同步 socket 範圍隔離、無 socket 時明確拒絕、登入沉默逾時／取消；以轉送到真實 Redis 的 TCP／TLS 測試代理驗證同時 connect 只建立一條連線、閒置不中斷、分段 RESP 超過總 read deadline 仍成功、RPUSH 已提交但回應遺失時只插入一次、socket cork 寫入逾時、Heartbeat 逾時及重連後讀取。TLS 使用公開測試 CA，驗證 socket.authorized=true，production 仍維持 rejectUnauthorized=true。原有 Redis string／hash／list／set／zset／stream／JSON、DB 隔離、游標與 TTL 整合案例全部開啟讀寫期限。

Node 24.21.0 完整一般測試 **143 passed／68 skipped**，完整整合 **113 passed／1 skipped**（16 檔）。最後補上 ready 時序案例後，Redis 專項 **9 passed**；TypeScript 與 production build 再次通過。總表仍為 **57 已實作、5 部分實作、0 未實作**，原生匯出、Windows ODBC、ASE 及其餘 client encoding 缺口未隱藏。

Node 介面依據：[net.client.socket diagnostics channel](https://nodejs.org/download/release/v24.15.0/docs/api/diagnostics_channel.html#event-netclientsocket)。

最終 Electron 桌面 smoke 通過 Redis 讀寫期限保存、重新開啟設定的繁中值、啟用期限時的真實 Heartbeat，以及主動斷線後停止檢查；`.local/redis-io-timeouts.png` 已視覺檢查。此流程也驗證打包至 main bundle 的 Node socket 通知在 Electron 執行環境可用。測試 App 已關閉，專用資料庫由 finally 清理，Redis 整合測試的隨機 key 已刪除；整合服務已停止。

## 2026-09-30：Redis 用戶端字元集（FUNCTIONS 06 持續補齊）

- 連線表單提供 UTF-8（預設）、Latin-1、Windows-1252、Big5、GBK、GB18030、Shift JIS、EUC-JP 下拉選項，沿用共用 schema、Command Bus、設定保存與重新連線。切換引擎清除前一引擎的 charset，避免 MySQL 字元集名稱流入 Redis 設定。
- Redis adapter 以公開 typeMapping 接收原始 Buffer，再依選擇編解碼鍵名、文字值、集合元素及 Stream 欄位。固定 iconv-lite 0.7.3 為直接相依；保留 BOM，對輸入與回應進行往返驗證。無法無損表示的字元在連線／傳送命令前拒絕，錯誤編碼的回應也拒絕，不以替代字元悄悄改寫資料。這是文字編碼選擇，不是任意二進位編輯器；不轉換伺服器既有資料。
- JSON 文件及路徑維持 UTF-8，JSON 的 Redis key 使用所選編碼；INFO／CONFIG 回應按 UTF-8 處理。ASCII 協定參數維持原語意。SCAN 保留使用者的 ASCII glob 運算子，非 ASCII 字元編碼後的特殊位元組會跳脫，避免 Big5「許」及 Shift JIS「ソ」的尾端反斜線被當成 pattern 語法；比對仍遵循 Redis 的位元組規則。
- String 讀取先檢查 STRLEN 上限，避免先截斷多位元組字元再解碼；保留原本 1 MiB 編輯器與 UTF-8 顯示大小限制。

驗證：新增 10 項單元案例及 9 項真實 Redis 整合案例，逐一比較八種編碼的已知精確位元組，涵蓋六種基本型別、中文鍵搜尋、無法表示的輸入不改寫既有值，以及 Redis 8.2 JSON 在 Latin-1 key 下保存 Unicode 文件。完整整合 **132 passed／1 skipped**（17 檔）；TypeScript／production build 通過。一般測試首次與建置／整合並行時，有一項 SQLite 結構測試達到既有 5 秒期限；工作結束後未更改程式或測試期限，完整重跑 **153 passed／77 skipped**。均使用獨立 Node 24.21.0，系統 Node 未更換。

清單維持 **57 已實作、5 部分實作、0 未實作**；其他引擎的可選 client encoding、部分原生 transport 期限及 ASE 匯出仍未完成。

Electron 桌面 smoke 最終完整通過：保存／重開 Big5 選項、共用 IPC 寫入及讀回中文鍵值、既有各引擎讀寫期限與 Heartbeat、專用資料庫清理；`.local/redis-client-charset.png` 已視覺檢查。首次操作驗證通過後，清理 DROP DATABASE 被測試用 1500ms read timeout 中斷；確認伺服器其實已刪除資料庫，修正清理流程先停用短期限與 Heartbeat，再完整重跑通過。成功訊息移至 finally 清理完成後才輸出，避免只完成操作卻誤報整個 smoke 成功。

## 2026-09-30：PostgreSQL 原生匯出網路讀寫逾時（FUNCTIONS 09～10 持續補齊）

- pg_dump 沒有對應的獨立 socket 讀寫期限參數；只在連線啟用 Read／Write timeout 時，建立本次工作專用、綁定 127.0.0.1 隨機埠的轉送層，目標固定為已儲存的 PostgreSQL 連線。libpq hostaddr 指向 loopback，保留原 host 供名稱驗證／驗證協定使用。轉送層不解密 TLS、不讀取憑證或改動密碼驗證，也不重送資料；原 pg_dump verify-full 模式保留。
- SocketTimeouts 套用於實際通往資料庫的 socket，Write timeout 監測上游 callback，並非本機 pg_dump 寫入 loopback 的完成狀態。原生匯出視整個工作（包含 TLS／登入）為作用範圍，按 transport 無活動時間計時；不是解析每個 SQL 完成訊息的逐查詢期限。已知的本機輸出處理與下游背壓會暫停 Read timeout；原生工具內部長時間計算而沒有網路往返仍計入無活動時間。
- 完成、取消、native process 失敗、轉送錯誤都關閉 listener 與 socket；保留半關閉後待送出的回應，避免截斷最後一塊輸出。原生程式拒絕 TLS 憑證而主動 reset 本機 socket 時，保留其原始憑證錯誤，不用通用 ECONNRESET 蓋過。匯出原有的工作期限與檔案大小上限保持獨立。
- 新增四項真實 socket 測試：持續接收超過總 read deadline、輸出處理暫停／恢復、上游 socket cork 阻塞寫入、半關閉 256 KiB 完整輸出與 listener 清除，以及端到端 TLS 信任與加密流量期限。PostgreSQL 原生匯出完整還原測試啟用讀寫期限，另確認等待表鎖時 read timeout 結束 pg_dump／backend。以原生 pg_dump + 測試 TLS 前端 + 真實 PostgreSQL 驗證可信憑證成功、主機名稱不符／缺少根憑證拒絕；測試 CA 僅傳給該測試子程序，不變更使用者 trust store。

Node 24.21.0 一般測試 **157 passed／78 skipped**；TypeScript、production build 與格式檢查通過。總表仍為 **57 已實作、5 部分實作、0 未實作**，SQL Server 原生匯出、Windows ODBC、ASE 與其他用戶端編碼缺口繼續追蹤。

完整資料庫整合 **133 passed／1 skipped**（17 檔），包含 PostgreSQL native TLS 與匯出等待鎖期限。參數依據：[libpq host／hostaddr](https://www.postgresql.org/docs/17/libpq-connect.html#LIBPQ-PARAMKEYWORDS)、[verify-full](https://www.postgresql.org/docs/17/libpq-ssl.html)。

`scripts/smoke-postgres-export.mjs` 完整通過：設定讀寫期限後的真實鎖定逾時、解除鎖定再匯出／儲存、只有結構模式、Command Bus 重新匯入及 Unicode／精確小數／CRLF 還原；`.local/postgres-sql-export.png` 已視覺檢查。專用資料庫、測試 TLS trust store 與 pg_dump session 已清理，測試桌面已關閉。未重新封裝發行安裝程式。

## 2026-09-30：SQL Server 帳密 TCP 原生匯出讀寫逾時（FUNCTIONS 09～10 持續補齊）

- SQL Server 原生匯出啟用連線 I/O 期限時，使用短期 loopback 轉送層監測實際上游 socket，涵蓋原生登入與匯出期間的網路活動。IPC 輸出等待本機寫入／ACK 時暫停讀取期限；失敗與取消關閉子程序、listener 及全部 socket，不重送命令。現階段接受 SQL 帳密與明確 TCP host／port；Windows 驗證、named instance／pipe／shared memory 的此期限路徑仍未提供。
- SMO 同時使用 metadata 與鎖定／資料連線。轉送層改成工作共用的讀取活動時鐘，任一連線收到資料即重設，避免閒置 sibling 誤判；實際寫入仍使用逐 socket 的 callback deadline。共用 SocketTimeouts 改以最小 transport 介面接收真實 socket 或只彙總完成 callback 的活動介面，沒有改動其他引擎的計時語意。
- 原生 SqlConnectionStringBuilder 設定 HostNameInCertificate 為原始主機，Data Source 才指向 loopback；包含伺服器強制加密的情況，仍保持 TrustServerCertificate=false。I/O 期限需要 Microsoft.Data.SqlClient 5.0+ 的 SqlServer PowerShell 模組；舊 SQLPS 缺少名稱驗證分離能力時明確要求更新，不降低驗證或忽略期限。未啟用期限仍保留原有 SQLPS 路徑。
- 改為明確呼叫 SMO ConnectionContext.Connect，再檢查伺服器版本。修正失敗的延後 VersionMajor 存取可能被當成 0、把 TLS／登入失敗誤報為 SQL Server 版本過舊的問題。
- 從 PSGallery 將 SqlServer 22.4.5.1 保存至忽略版控的 `.local/powershell-modules`。`sqlserver-test-env.mjs` 僅替整合／匯出桌面測試子程序加入此 PSModulePath，未修改使用者模組安裝。README 說明測試下載與正式環境的模組需求。

新增多 session 持續進度、明確 TCP 端點限制測試；真實 SQL Server 匯出／重建／精確值比對已在 I/O 期限下通過，包含持有 TABLOCKX 時觸發 Read timeout、不受信任 TLS 憑證拒絕、共享鎖及取消後 session 清除。本輪未建立新的受信任 SQL Server TLS 伺服器，TLS 正向傳輸依既有轉送層 TLS 測試與原生 HostNameInCertificate 能力驗證；不將憑證拒絕案例描述為受信任 TLS 匯出成功。

一般測試 **159 passed／78 skipped**（Node 24.21.0）。清單維持 **57 已實作、5 部分實作、0 未實作**；Windows 驗證、ASE 及其他用戶端字元集仍待補齊。

完整整合 **134 passed／1 skipped**（17 檔）；另以原有 SQLPS 與本機 Windows 身分執行 native export 專項 **1 passed**，確認未啟用 I/O 期限的既有 Windows 匯出／還原仍可用。最後補強 EOF 後從活動集合移除連線，相關 transport 回歸 **12 passed／4 skipped**；TypeScript／production build 再次通過。TLS 名稱驗證參數依據：[Microsoft.Data.SqlClient HostNameInCertificate](https://learn.microsoft.com/en-us/dotnet/api/microsoft.data.sqlclient.sqlconnectionstringbuilder.hostnameincertificate?view=sqlclient-dotnet-core-6.1)。

SQL Server 匯出 Electron smoke 通過：啟用期限後等待 TABLOCKX 的失敗提示、解除鎖定再匯出、結構與資料／只有結構、原生儲存、Command Bus 重新匯入及精確數字／Unicode 還原；`.local/sqlserver-sql-export.png` 已視覺檢查。測試 App 已關閉，專用資料庫與原生匯出 session 已清理。未重新封裝安裝程式。

## 2026-09-30：Windows TCP 驗證的讀寫逾時與 SPN（FUNCTIONS 09～10 持續補齊）

- 連線表單新增 Server SPN；Windows 驗證啟用 Read／Write timeout 時必須指定已登錄的 SPN 與明確 TCP 主機／通訊埠，不猜測 DNS 別名或網域身分。共用 schema 驗證、ConnectionService 保存及設定變更斷線流程皆已接上；切換回 SQL 帳密時清除 SPN，Windows 驗證仍不保存 SQL 密碼。未開啟期限且未填 SPN 時保留原有 named instance、shared memory／named pipe 連線方式。
- 每條 ODBC 實體連線擁有獨立 loopback 轉送層。Address 指向轉送埠，ServerSPN 與 HostnameInCertificate 仍指向實際伺服器，TrustServerCertificate 保持 No；TLS 原樣通過。mssql 12.7.2／msnodesqlv8 5.5.0 固定版本，僅在 pool instance 及該 instance 建立的 native connection 上接入建立、query／queryRaw、pause／resume 與關閉生命週期，沒有全域 prototype 修改。
- 登入與查詢／DDL／交易／SQL 檔案批次期間監測上游 socket。閒置與消費暫停不計讀取時間；其他 session 的流量不延長本 session 的期限。失敗關閉該傳輸、標記 native connection 失效，保留原始 Network read／write timeout 訊息；ConnectRetryCount=0，不重送失敗寫入。連線池建立加入共用 pending Promise 與世代檢查，避免並行 connect 重複建立及 disconnect 後遲到的登入復活。
- 原生 SMO 匯出接受同一明確 SPN，透過 Microsoft.Data.SqlClient 的 Server SPN 指定；仍要求 5.0+ 才能同時保留 SPN／憑證名稱與轉送端點。舊 SQLPS 缺少明確 SPN 能力時回報更新需求；未填 SPN 且未開啟 I/O 期限的既有路徑不受影響。

真實 Driver 18 + Docker SQL Server 的測試登入採 SQL 帳密，只隔離 Windows 網域身分條件；其餘連線字串與轉送／native pool 路徑相同。已驗證閒置不中斷、持續回應超過總 read deadline、並行 stalled 與 progressing session 互不干擾、暫停讀取、交易錯誤、上游 cork 寫入停滯、恢復後的新查詢、已提交 INSERT 在回應逾時後只有一筆，以及 TLS 拒絕不受信任憑證。Windows ODBC 的部分本地化訊息經 ANSI 橋接會顯示問號，TLS 拒絕測試也辨識驅動保留的 encryption 錯誤說明連結。

完整一般測試 **162 passed／80 skipped**；完整整合 **135 passed／1 skipped**（18 檔）。以本機 Windows 身分執行查詢與原有 SQLPS 匯出專項 **12 passed／1 skipped**；TypeScript 與 production build 通過。後續新增 Windows TCP 身分／查詢／SQL 檔案／DDL 專項，以及 Windows 匯出期限模式，可由 README 所列環境變數啟用。本機 SQL Server TCP 與 named pipe 均未開啟，未修改伺服器設定；**尚未驗證 Windows TCP 的 NTLM／Kerberos 或其原生匯出端到端**，不以 Docker 帳密測試取代這項證據。總表維持 **57 已實作、5 部分實作、0 未實作**；ASE 期限／匯出與其他用戶端編碼缺口仍保留。

參數依據：[ODBC connection attributes](https://learn.microsoft.com/en-us/sql/connect/odbc/dsn-connection-string-attribute)、[SQL Server SPN](https://learn.microsoft.com/en-us/sql/relational-databases/native-client/features/service-principal-name-spn-support-in-client-connections?view=sql-server-ver15)、[SqlClient Server SPN](https://learn.microsoft.com/en-us/dotnet/api/microsoft.data.sqlclient.sqlconnection.connectionstring?view=sqlclient-dotnet-standard-5.1)。

Electron 連線選項 smoke 最終通過：Windows SPN 必填提示、保存與重新開啟、切換回帳密模式清除 SPN 並重新填入憑證；既有 MySQL／PostgreSQL／SQL Server／Redis 期限、資料庫選項、Big5 資料與 Heartbeat 也通過。首次發現 SPN 說明文字併入可存取名稱，已補上明確 aria-label 後完整重跑；`.local/windows-io-settings.png` 已視覺檢查。測試 App 與專用資料庫已清理，沒有修改使用者原有開發程序；未重新封裝發行安裝程式。

## 2026-09-30：ASE session 的讀寫期限（FUNCTIONS 09～10）

ASE 表單及共用 schema 開放 Read／Write Timeout，0 保持原有直連路徑。啟用時每條原生 session 配置獨立 loopback 傳輸：登入及工作期間監測上游進度，閒置 anchor 暫停讀取計時；同一 SQL 檔案失敗後不另開連線或重送語句。取消登入立即清理 listener，遲到的 native callback 也會關閉 session。`HASession=0;RetryCount=0` 限制驅動自行重試／切換端點。

搭配 TLS 時，由 App 使用 PEM CA 驗證原始主機名稱／IP 及信任鏈，至少 TLS 1.2；SAP ODBC 到 App 使用本機回送連線。這是新增的上游 TLS 模式；原有 PostgreSQL／SQL Server 的 TLS 原樣轉送路徑保持不變。沒有使用 SAP ODBC 未列出的 `Encryption=none` 或 SQL Server 專用重試參數。參數與協定依據見 [SYBASE_SUPPORT.md](../engines/sybase-support.md)。

一般測試 **172 passed／80 skipped**，包含 ASE 專用 10 項真實 TCP／TLS socket + 模擬 native driver 測試：進度、閒置 heartbeat、並行隔離、兩種傳輸的寫入停滯、SQL 檔案失敗後禁止重送、憑證名稱／信任拒絕、取消／逾時登入與資源釋放。開發中雙重管理 raw socket 與 TLS wrapper 曾導致 Windows Node worker 異常退出，已改為直接建立／管理單一 TLSSocket 後通過全套測試；沒有忽略 worker 錯誤。

TypeScript 與 production build 通過；Electron ASE smoke 驗證 TLS 必填、缺少驅動錯誤與密碼保護，並新增 Read／Write Timeout、Heartbeat 的儲存及重新開啟檢查。真實 ASE 測試新增 `ASE_READ_TIMEOUT`／`ASE_WRITE_TIMEOUT` 設定及有條件 WAITFOR 期限／恢復驗證，因缺少伺服器與 SAP 驅動未執行。總表仍為 **57 已實作／5 部分實作／0 未實作**；此批測試不代表 ASE 真機相容性已確認。用戶端編碼選項與 ASE SQL 匯出缺口仍在追蹤。

## 2026-09-30：ASE 原生 SQL 結構匯出（FUNCTIONS 16 持續補齊）

- 新增 `sybase/sql-export.ts`，直接啟動 SAP DDLGen 的 Java main class；`-XDE` 保留原生相依排序，`-CNUMBER=1` 限制工具連線數。密碼以 `-Pext` 的標準輸入傳入，不經 shell 或命令列。工具的 SQL、錯誤與進度檔僅存於專用暫存目錄，完成／失敗後清除；回報的錯誤先遮蔽登入密碼。
- ASE 連線設定新增 Java／DDLGen.jar／jconn4.jar 路徑，沿用共用 schema、保存與修改設定後斷線。資料庫選單及共用 SQL 匯出對話框提供「只有結構」，經 Command Bus／權限／事件／原生儲存處理。資料模式仍明確停用，沒有將結構檔標成含資料。
- 原生工具使用 App 的 TCP／TLS 上游連線，TLS 驗證原始主機及 PEM CA。支援取消、讀寫無進度期限與工具輸出閒置期限；處理程序非零結束、錯誤紀錄、無效 UTF-8、大小／批次上限及意外資料庫名稱都會拒絕交付檔案。保留 CREATE DATABASE／USE／裝置設定，介面提醒還原前檢查環境。
- 新增自行撰寫的 Java 測試替身，由真實 JDK 編譯後以實際子程序執行。一般測試 **186 passed／80 skipped**；其中 ASE 匯出 13 項，涵蓋原生程序邊界、Unicode、密碼輸入、錯誤遮蔽、取消／期限、範圍檢查、檔案清理及共用命令匯出／存檔／匯入預覽。額外驗證修改三種工具路徑均使舊 adapter 失效。TypeScript、production build、ASE 設定桌面 smoke 通過。

測試替身不含 SAP 程式碼，不代表 SAP ddlgen／ASE 真機通過。真機整合測試已加上選用工具路徑與四類物件輸出檢查，但目前沒有工具與伺服器，因此未執行；真實腳本還原、資料匯出仍待補齊。統計維持 **57 已實作／5 部分實作／0 未實作**，未宣告整體目標完成。官方參數依據及操作限制見 [SYBASE_SUPPORT.md](../engines/sybase-support.md)。

既有 SQLite SQL 匯出桌面回歸通過：兩種模式、原生儲存、中文介面及 SQL 檔案還原；`.local/sql-file-export.png` 已視覺檢查。ASE 桌面 smoke 驗證三種工具路徑保存／重新開啟；未以替身宣稱 ASE 伺服器連線或實際還原成功。測試 App 均已關閉，保留使用者原有 9 月 29 日開發程序；未重新封裝安裝程式。

## 2026-09-30：ASE JDBC 資料匯出（FUNCTIONS 15 持續補齊）

- 共用 SQL 匯出對話框開放 ASE「結構和資料」。使用 App 自有 Java source worker（JDK 11+）與使用者安裝的 jconn4.jar，憑證僅以 stdin 傳入；沿用 Application Command Bus、權限、取消、事件與原生存檔服務。Java source 隨主程序打包，不需 renderer 存取資料庫。
- 唯讀交易取得全部資料表 SHARE 鎖，以 @@error 確认取鎖成功；工作完成 rollback。來源不執行資料寫入。JDBC BigDecimal 避免 JavaScript Number 精度損失；文字以 Unicode escape、二進位以 hex 輸出，時間由伺服器 style 140 保留微秒。明確欄位 INSERT、IDENTITY_INSERT 與 identity high-water mark；computed／timestamp 由目標重新產生。
- 以原生完整 DDL 與 -FRI,TR DDL 核對批次未改寫及資料表清單一致；拒絕沒有排除外鍵／Trigger 的工具輸出。先結構、再資料、最後延後的外鍵與 Trigger，保留其原始 USE／SET 上下文。資料完成仍持有鎖時再比較原生結構，變更即失敗；未知 DDL 排序、加密／遠端表／存取規則、讀取警告、截斷、未知型別與大小超限均拒絕交付。
- Java 輸出每筆等待主程序 ACK，處理本機寫入或其他原生結構工作時暫停該 JDBC session 的讀取期限。程序非正常結束、取消與目的檔案失敗會清理工作程序、listener 及專用暫存目錄。

驗證：一般測試 **198 passed／80 skipped**，ASE 匯出共 **25 項**；包含真實 Java 子程序、自行撰寫的 JDBC／DDLGen 替身、精確數值與 Unicode／二進位／微秒輸出、取鎖與讀取失敗、外鍵／Trigger 排序、結構變更、取消及兩種模式經 Command Bus 存檔／匯入預覽。首次資料模式服務測試因預設輪詢只等 1 秒而失敗，調整成 10 秒等待原生 Java 工作後通過全套；未略過失敗。TypeScript 與 production build 通過。ASE 設定桌面 smoke、SQLite 共用匯出兩種模式／原生儲存／中文介面／匯入往返通過，測試 App 已關閉。

仍沒有 SAP JDBC／DDLGen 與 ASE 伺服器，因此上述替身不等於真實還原驗收。選用整合測試新增 ASE_EXPORT_DATA=1，明確啟用整個測試資料庫的鎖定資料匯出。操作與限制見 [SYBASE_SUPPORT.md](../engines/sybase-support.md)；功能總表維持 **57 已實作／5 部分實作／0 未實作**，不宣告全部完成。Heartbeat Interval 的澄清已反映於清單與設定，其 11 項連線選項測試亦通過。

## 2026-09-30：PostgreSQL 用戶端編碼（FUNCTIONS 06 持續補齊）

PostgreSQL 連線表單開放 UTF8、LATIN1、WIN1252、BIG5、GBK、GB18030、SJIS、EUC_JP。共享 schema 驗證所選值，沿用修改傳輸設定後關閉舊連線的生命週期。SQL Server 仍顯示原生 Unicode／欄位定序機制，ASE 仍固定 UTF-8，未把不適用的選項假裝成可設定。

新增 text-protocol.ts，在 pg Connection 的完整協定訊息邊界轉換 SQL、文字參數、欄位名稱、文字結果、通知及錯誤；binary Bind 值、SCRAM、TLS 與控制訊息保持原始位元組。處理分片封包與重新計算長度，最多 64 MiB／frame，逐 byte 只複製一次以避免大欄位分片時反覆串接。拒絕有損編碼、錯誤格式及含 NUL 的 startup 參數。pg 固定於本機實際驗證的 8.23.0，package.json 與 lockfile 一致。

查詢、metadata、DDL、SQL 檔案及 Heartbeat 共用這條路徑；pg_dump 獨立輸出 UTF-8，還原時需使用 UTF8 連線。SQL 中途改變 client_encoding 會關閉 session 並回報，不交付可能錯碼的結果；結果解碼失敗亦提醒語句可能已執行，不自動重送。唯讀查詢改用有界 portal，最多取 offset＋limit＋1 列，再 Close／Sync 接收伺服器完成狀態；維持分頁與輸出限制，且不必讀完整個無界 SELECT 才檢查編碼。

驗證：一般測試 **207 passed／91 skipped**；完整整合測試 **153 passed／1 skipped**。另於最終協定實作執行 PostgreSQL 專用 **20 項全部通過**，含八種編碼的真實 SQL／識別字／參數／JSON／陣列／SQL 檔案往返、bytea 原始位元組、cached prepared statements、分片封包、BOM、拒絕不相容文字而未 INSERT、查詢筆數限制、編碼切換、TLS 信任鏈與 Unicode 使用者／SCRAM 密碼。最後補入 startup NUL 檢查後，9 項離線協定測試再通過。首次測試找出 pg-pool 非 enumerable 密碼遺失及 TextDecoder 移除開頭 BOM，均已修正；未忽略失敗。原生 pg_dump 測試另使用 BIG5 連線設定，確認匯出仍能保留 UTF-8 emoji 並還原。

TypeScript／production build 通過。Electron 連線選項 smoke 通過 Big5 選擇、保存、重新開啟、SHOW client_encoding、中文欄位與內容，以及既有其他引擎的設定／期限／Heartbeat 流程；過程比預期久，檢查仍在執行的程序後自然完成，未以逾時推定停止或重啟。截圖 .local/postgres-encoding.png 已視覺檢查。測試 App 及本輪啟動的整合服務均已關閉；保留原有開發程序與測試 volumes。

總表仍為 **57 已實作／5 部分實作／0 未實作**。剩餘主要缺口為 ASE 可選用戶端編碼、ASE 真機相容性／匯出還原，以及 Windows TCP 身分驗證端到端證據；未宣告整體目標完成。依據與操作方式見 README 的「連線進階設定」及 FUNCTIONS_IMPLEMENTATION_MATRIX.md。

## 2026-09-30：Heartbeat 澄清回歸與 ASE 編碼路徑核對

確認 FUNCTIONS.txt 第 07 項與表單均為 Heartbeat Interval，單位秒，0 停用；已連線後排程、避免重疊，關閉時清除排程，失敗阻止隱式重連。再次執行 connection-options 與 sybase 測試共 **27 項通過**，TypeScript 檢查通過。本輪沒有修改此既有執行行為。

核對實際安裝的 msnodesqlv8 5.5.0 C++ 原始碼：VARCHAR／TEXT 經 SQL_C_CHAR，再由 Napi::String::New 按 UTF-8 轉為 JavaScript 字串；沒有可供一般查詢使用的文字原始位元組設定。這證實直接更換 ClientCharset 不能實作無損多編碼支援。已新增 SYBASE_ENCODING_PLAN.md，記錄 jConnect 查詢傳輸方案、完整 session／安全邊界及真機驗收條件；僅為設計研究，尚未接入新傳輸或開放 ASE 編碼選項。缺少 SAP 工具與伺服器的限制仍在，總表統計不變。

## 2026-09-30：ASE JDBC 編碼與查詢 session 實作

已將前述編碼方案接入。ASE 保留原有 ODBC UTF-8，另提供 JDBC UTF-8、Latin-1、Windows-1252、Big5、GBK、GB18030、Shift JIS／MS932、EUC-JP。選用 JDBC 須設定 SAP jconn4.jar 並具備 JDK 11+；沿用 Java 路徑自動偵測，查詢不要求 DDLGen.jar。共用 schema 驗證、表單中英文說明與修改後重連流程完成；JDBC 模式隱藏不適用的 ODBC driver 欄位。

新增 jdbc-session.ts／AseQuerySession.java，每個實體 session 一個子程序，涵蓋 query、metadata、DDL、SQL 檔案與 Heartbeat。16 MiB 長度前綴協定、UTF-8/base64 文字、精確十進位字串與二進位值，保留空字串／NULL／空 bytes；每列 ACK、有界 JDBC setMaxRows 及既有 8 MiB 回應限制。使用多位元組 converter 並在 SQL／文字參數送出前嚴格編碼往返檢查。啟用伺服器轉碼與截斷錯誤，登入及查詢前後核對 @@client_csname；結尾警告與編碼切換不交付成功結果，提醒寫入可能已發生。

每個 JDBC session 沿用原生 TCP／TLS relay，TLS 一律驗證原始主機及 PEM CA，獨立讀寫期限、取消／登入期限／斷線均關閉 worker、socket 並清理專用目錄，不重送語句。密碼僅透過 stdin，回報錯誤遮蔽密碼。Java 工具偵測抽成共用 java-tools.ts，ASE 原生匯出回歸仍通過；匯出繼續獨立使用 UTF-8。

驗證：最終一般測試 **222 passed／91 skipped**、TypeScript 及 production build 通過。新增 JDBC **15 項**使用真實 Java 程序與自製 Driver 契約替身，涵蓋八種 charset 屬性／參數、精確數字／Unicode／空值／二進位／微秒文字、同 session 重用、無損拒絕、結果限制後的截斷警告、伺服器編碼切換、過大與未知型別、取消／逾時、TCP／TLS 讀取期限隔離、閒置 Heartbeat 及不可信憑證拒絕。建置曾指出新增 socket 測試回呼型別不夠精確，補上 Buffer 型別後重跑通過。

最終 Electron smoke 通過 ODBC 既有表單、TLS 必填、缺少 ODBC／JDBC 工具、Big5 保存／重開、中文標籤與憑證保護；截圖 .local/ase-jdbc-encoding.png。測試 App 與 Java worker 已結束，只保留先前既有 Electron 程序；本輪沒有啟動整合服務。可選真機測試新增 ASE_CHARSET 與依編碼調整的 CRUD 文字樣本。

上述 Driver 替身不是 SAP 驅動或 ASE TDS 模擬器；仍無 SAP ODBC／jConnect／DDLGen 及 ASE 伺服器的真機證據，也未補足 Windows TCP 身分驗證端到端環境。總表維持 **57 已實作／5 部分實作／0 未實作**，不能宣告全部完成。操作及待驗收項目已更新於 README、SYBASE_SUPPORT.md、SYBASE_ENCODING_PLAN.md 及功能對照表。

## 2026-09-30：修正 ASE JDBC 腳本批次狀態

後續檢查發現 JDBC 每段 SQL 前後的編碼探測查詢會改變 ASE 的 @@rowcount／@@error，且 JDBC setMaxRows 可能透過額外 SET ROWCOUNT 改變 session。新增 Driver 契約回歸案例，先重現 UPDATE 之後的批次讀到錯誤 rowcount，再修正。

SQL 檔案與多語句 DDL 現在使用保留 session 狀態的執行模式，批次間不插入編碼探測或 setMaxRows。SQL 檔案在整份 task 完成後進行一次有期限、可取消的編碼核對；DDL 在提交前核對。一般獨立查詢仍在前後檢查。編碼不符仍使作業失敗；腳本不得動態切換編碼，結尾失敗不會回滾已提交的語句。新增回歸覆蓋 rowcount、捕捉錯誤後繼續的 @@error、結尾編碼不符、DDL 提交前核對與最後批次後取消；可選 ASE 真機測試也加入暫存表與跨批次狀態案例。

驗證：sybase-jdbc、sybase、sybase-io、sql-script 四個測試檔 **48 passed／4 skipped**；JDBC 專用共 17 項。TypeScript 與 production build 通過。此輪沒有介面變更，未重複桌面表單驗證。真實 ASE 案例因缺環境保留待驗證，未當作成功。

本輪唯讀環境盤點：.local/sybase.env 不存在，ASE 主機／資料庫／帳密／jConnect／DDLGen 設定皆未提供；已註冊 SAP ASE ODBC 驅動數為 0。Windows TCP 整合測試設定未提供，本機 MSSQLSERVER 的 TcpEnabled=0；未更改服務或啟用 TCP。功能對照表的剩餘驗收順序與 JDBC 證據連結已更新，整體目標維持未完成。

## 2026-09-30：UI 設計規範與統一審查

- 建立 `.agents/skills/database-workspace-ui/SKILL.md`，並安裝同版本至本機 Codex skills；`AGENTS.md` 引用規範。
- 新增 `design-system.css`，統一 4px 間距尺度、13px UI 本文、12px 次要文字、32px 控制項、36px 選單列及上下 8px padding；色彩使用明暗語意 tokens。
- View 編輯器抽成 `ViewDesigner`，使用定義／欄位／進階分類；新增 View、Index／Trigger 編輯採同一分類列；草稿與 SQL／選項互斥保護保留。
- 整理工具列、導覽、表單、對話框及密集表格參數；連線表單內容獨立捲動，按鈕保持可見；close 改為 ghost，刪除連線標示 destructive。
- 修正 toast 阻擋資料列還原的回歸問題，保留浮動結構變更明細。
- 增加 `test:desktop:ui-design`，驗證實際元素幾何、分類導航、草稿／預覽與中英文、720p／1080p、明暗／system 主題。skill validator、typecheck／build、UI design、UI iteration、MySQL View／Index options、Redis 七型別及 Table structure 桌面流程通過。
- 詳細審查與可重現命令見 [ui-design-review.md](ui-design-review.md)；截圖在忽略版控的 `.local/ui-design/`。

## 導覽按鈕尺寸補正（2026-09-30）

- 新增 `UI_BUTTON_SIZES.md` 尺寸規範表，更新專案及本機 UI skill，同層級圖示動作必須指定相同 size。
- 瀏覽器群組 `+`、更多、展開、標頭動作及分頁關閉統一 `icon-sm`（28×28）；grid／Set NULL／autocomplete 動作 24×24，對話框／浮動視窗／通知關閉 32×32。
- Button 與 InputGroupButton 共用 size，數值集中於 design-system.css；移除動作的區域尺寸覆寫，以 ui-button 標記保留 Base UI render 組合後的樣式。
- 驗證：typecheck、build、skill validator、UI design、UI iteration、Table structure 全部通過；UI design 實際比對寬高／padding／圓角／字型，涵蓋四種新增／更多入口、密集 grid、中英文、明暗主題及 720p／1080p。
