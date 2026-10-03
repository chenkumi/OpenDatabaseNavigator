# 專案 Code Review — 2026-09-28

原始審查共確認 **7 項問題：5 項 P1、2 項 P2**。下列重現記錄描述修正前狀態；使用者要求修正後的處理結果列於此節。

## 修正追蹤（2026-09-28）

| 項目 | 狀態 | 實作與回歸證據 |
| --- | --- | --- |
| 1. MySQL session 污染 | 已修正 | 非唯讀操作結束銷毀 session；MySQL／MariaDB 實測 USE、SET、autocommit、BEGIN／ROLLBACK 不污染後續 scope。查詢不提供跨次交易。 |
| 2. 重新整理將草稿移到別列 | 已修正 | 載入期間停用編輯；回應檢查草稿版本；儲存綁定原始列主鍵，影響零列時保留草稿。Electron 慢速讀取與主鍵變更測試通過。 |
| 3. DDL 授權範圍過寬 | 已修正 | 十分鐘 grant 綁定完整驗證後 DDL 輸入；名稱、種類、欄位變更重新要求核准，同一內容可沿用核准。 |
| 4. 連線設定丟失草稿 | 已修正 | 名稱／顏色／群組保存不斷線；傳輸與驗證設定變更先檢查 dirty，確認捨棄才取消查詢並關閉相關分頁。 |
| 5. SQL Server 小數精度 | SQL 帳密已修正；Windows 有限制 | Tedious 20.0.0 封包層以 BigInt 解碼 DECIMAL／NUMERIC／小數 SQL_VARIANT 為精確字串。SQL 帳密含 38 位精度、NULL、小數主鍵更新通過。Windows NUMERIC 通過，但原生 msnodesqlv8 的 DECIMAL 仍先轉 double；新增 guard 拒絕 DECIMAL／SQL_VARIANT 結果，避免靜默失真，尚非完整型別支援。可改用 SQL 帳密或明確在伺服器端 CONVERT 為 NVARCHAR。 |
| 6. 刪除連線殘留分頁 | 已修正 | 共用草稿檢查與查詢取消流程，刪除時關閉相關分頁；其他連線分頁保留。 |
| 7. 全部預設值新增列 | 已修正 | MySQL 產生 `() VALUES ()`，其他 SQL 引擎產生 `DEFAULT VALUES`；五種配置的預設欄位、純自動編號及缺少必要欄位測試通過。 |

永久回歸測試：`tests/review-fixes.test.ts`、`tests/exact-decimal.test.ts`、`tests/sqlserver-auth.test.ts`、`scripts/smoke-review-fixes.mjs`、`scripts/smoke-sqlserver-auth.mjs`。原 `.local/review-*` 保留為修正前證據，不能用來判定目前行為。

Windows 精度限制是本輪新增的實機發現：`setUseNumericString(true)` 對 NUMERIC 有效，但原生 DECIMAL 分支使用 SQL_C_DOUBLE，字串也已被四捨五入。因此不以格式化假裝恢復精度、不自動重寫任意 SQL。含這些欄位的 Windows 資料表瀏覽會回報限制；錯誤不代表寫入語句未執行。

## 範圍與驗證

檢視主程序／preload IPC、Command Bus、MCP 權限與伺服器、憑證／稽核／持久化、SQL／Redis adapters、查詢／資料操作／結構與物件服務、連線及分頁生命週期、主要 renderer 編輯器與既有測試。目錄沒有 Git metadata，因此以目前完整工作目錄為準，並非僅審查某個 diff。

- `npm run typecheck`：通過。
- `npm test -- --maxWorkers=1`：63 通過、17 條件式略過。
- `npm run test:integration -- --maxWorkers=1`：17 通過；SQLite、PostgreSQL、MySQL、MariaDB、SQL Server、Redis 相關既有整合測試。
- 額外執行隔離的服務層探針及 Electron 桌面重現，確認下列缺陷。Windows 整合驗證驅動、封裝版本及其他作業系統不在本次動態重現範圍。
- 測試使用暫存 SQLite 與專案 Docker 整合環境，清除自行建立的 MySQL 測試庫／表，不觸碰既有業務資料。

既有測試通過不代表沒有錯誤；本次問題主要是缺少並行、連線變更、授權新命令與精度邊界案例。

## 1. [P1] MySQL 重用已被 USE 改變資料庫的連線，後續可能寫錯庫

位置：`src/main/database/adapters/mysql/mysql-adapter.ts:128`（歸還 session）、`src/main/application/services/connection-service.ts:89`（依宣告 database 快取 adapter）。

重現：以 `database: workspace` 建立 scope，在 query 執行 `USE review_<隨機字尾>`，然後仍以 `database: workspace` 執行不帶 schema 的 `data.insert`。兩個庫均有同名測試表。實測 requested database 為 `workspace`，但 `SELECT DATABASE()` 回傳另一個測試庫；insert 成功後 workspace 表為 0 列，另一庫為 1 列。

原因：任意 SQL 可改變 session 狀態，query 結束直接 `client.release()`；下一次借出的 session 沒有還原 database。scope、分頁路徑與 audit 宣告仍指向原庫，因此可造成跨分頁或後續操作誤寫。

建議：明確決定查詢分頁 session 模型。若維持無狀態共用 pool，歸還前重置 session 或丟棄被更改的 session；若支援 USE／交易，應獨立持有分頁 session 並同步 scope，不能把狀態污染帶回共用 pool。補上 USE、SET、交易跨呼叫案例。

## 2. [P1] 延遲完成的重新整理會把草稿移到另一筆資料列

位置：`src/renderer/src/components/TableView.tsx:70`（接收讀取結果）、同檔 `:131`（依目前 result 與 row index 產生更新條件）。

重現：先顯示 id=1 與 id=2，開始重新整理但暫停讀取回應；此時將第一列改為 `draft for id 1`，另一個操作刪除 id=1，再讓讀取完成。畫面第一列變成 id=2，卻保留 id=1 的草稿；按儲存後實測資料庫 id=2 的 label 被寫成 `draft for id 1`。

原因：loadSequence 只淘汰較舊請求，沒有防止請求送出後新建立的草稿被新結果覆蓋；edits 使用 row index，儲存時又從新 result 取 PK。一般重新整理期間也沒有禁止編輯。

建議：以原始 PK／穩定列識別保存草稿與原始更新條件；當讀取回應抵達時重新檢查草稿版本，已有修改就保留原始結果並提示外部變更。至少應阻止載入期間對舊結果新增編輯。

## 3. [P1] object.create 的十分鐘授權未綁定物件名稱與類型

位置：`src/main/mcp/permissions/permission-service.ts:30`。

重現條件：連線允許 Agent 寫入、Assist 模式且 DDL policy 為 ask。先核准建立 `approved_table` 並選擇十分鐘授權，同一 Agent 接著建立 `not_approved_table`，再建立 `not_approved_view`。兩者都成功，沒有第二次 approvalId。

原因：授權 scope 包含 table／key／sql／change，未包含 `object.create` 實際使用的 `name`、`kind`、`columns`、`selectSql`、`body` 等欄位。這些命令的 table 通常都是空字串，sql/change 都沒有值，因此不同物件與定義共用同一授權。

建議：依命令定義授權目標；DDL 建立操作應綁定完整正規化輸入／預覽 SQL，或先禁止此命令使用 session grant。需測試物件名稱、類型及 trigger/view 主體改變都重新要求核准。

## 4. [P1] 儲存連線設定會無提示丟失資料列草稿

位置：`src/main/application/services/connection-service.ts:35`；`src/renderer/src/App.tsx:839`。

重現：在 Table 資料列輸入未儲存修改，僅更改連線名稱並儲存。save 無條件 disconnect，App 將 TableView 卸載；重新連線後實測草稿已消失，「儲存變更」按鈕不存在，但 workspace 的 dirty 仍為 true。

原因：資料列及 Redis 草稿保存在 component state，連線儲存沒有沿用 explicit disconnect 的髒分頁確認／處理流程。即使未更動 host／database，仍會中斷並卸載編輯器。

建議：名稱、顏色、群組等純中繼資料更新不要重建連線；需要換連線時，先以統一流程檢查草稿與正在執行的工作，保留草稿或要求明確處理。同步清理 dirty，避免空草稿仍顯示未儲存。

## 5. [P1] SQL Server DECIMAL/NUMERIC 在回應前已喪失精度

位置：`src/main/database/adapters/sqlserver/sqlserver-adapter.ts:152`；`src/main/database/adapters/network/common.ts:10`。

實測：`SELECT CAST('123456789012345.123456' AS DECIMAL(21,6)) AS amount` 回傳 JSON number `123456789012345.12`。

原因：SQL Server driver 的十進位結果直接傳入 ResultCollector，normalize 只處理 bigint／Date／Buffer，沒有十進位的無損表示；在轉成字串之前數值已被 IEEE-754 Number 四捨五入。精確顯示、以該值編輯或作為鍵條件均受影響。

建議：在 driver 解碼／查詢結果階段保留 decimal 的精確文字或等效無損表示，不能對已四捨五入的 Number 再做 String。對正負值、不同 precision/scale、大數與小數鍵加入 round-trip 測試；GUI 使用文字編輯。

## 6. [P2] 刪除連線後仍留下無法重新連線的孤立分頁

位置：`src/main/application/services/connection-service.ts:42`；`src/main/application/application.ts` 的 `connection.delete` 命令。

實測：開啟一個相關分頁後刪除連線，connections 數為 0，但 workspace.tabs 仍為 1，分頁保留已刪除的 connectionId。UI 會顯示「雙擊連線」，但對應連線已不存在；工作區持久化也保留這些分頁。

建議：刪除連線應先以同一套髒分頁保護，取消執行中查詢並關閉相關分頁，再刪除設定和憑證；失敗時保持一致狀態。需涵蓋乾淨／髒分頁與重新啟動還原。

## 7. [P2] 新增列無法使用全部預設值

位置：`src/main/database/sql-builder.ts:59`。

重現：SQLite 建立 `defaults_only(id INTEGER PRIMARY KEY, label TEXT DEFAULT 'auto')`，在新增列表單讓所有欄位保持「省略」。GUI 傳入 values={}，`data.insert` 回傳 `At least one value is required.`；同一表執行原生 `INSERT INTO defaults_only DEFAULT VALUES` 成功。

原因：表單允許省略欄位以採用預設／自動產生值，但 SqlBuilder 對空 values 一律拒絕，沒有依引擎產生預設列語法。

建議：對空 values 產生相應引擎的 default-row INSERT，讓資料庫檢查必要欄位約束。補上純 identity／default 表與缺少必要欄位的測試。

## 重現證據

本機隔離探針保存在 `.local/review-probes.ts`／`.local/review-probes.mjs`，輸出為 `.local/review-evidence.json`；桌面重現為 `.local/review-ui.mjs`，輸出為 `.local/review-ui-evidence.json`。桌面探針只在自己的 Electron 測試程序攔截一次 IPC 回應以模擬慢速查詢，不更改正式程式碼。

優先順序建議：先修錯庫／錯列寫入，再修授權與草稿保存、數值精度，最後處理孤立分頁與預設列新增。上述七項均有程式碼依據與隔離重現；此審查不能證明其他執行環境與所有資料庫特殊 DDL 均無缺陷。
