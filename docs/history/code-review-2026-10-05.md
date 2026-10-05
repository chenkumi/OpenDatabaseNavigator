# Code Review 2026-10-05

涵蓋主程序／MCP、服務層、資料庫 adapters 與 renderer。審查結果來自分區唯讀審查，未在真實資料庫逐項重現；標示「已驗證」者表示已追到依賴套件原始碼確認。

## 已修正

| 項目 | 位置 |
|---|---|
| PostgreSQL 借出的 client 無 `error` listener，連線中斷會使主程序 uncaughtException（已驗證） | `postgres/postgres-adapter.ts` |
| 刪除或編輯連線時，microtask 內的 `status()` 對已刪除連線丟例外 | `connection-service.ts` |
| MySQL 匯出整個串流受 `queryTimeout` 限制，改為無進度才逾時 | `mysql/sql-export.ts` |
| SQL Server／Sybase `validateFragment` 禁用字不全（`DEFAULT 0 KILL 53`） | `database/structure-sql.ts` |
| SQL Server 共用 pool 殘留 session 狀態，非唯讀查詢改用獨立連線 | `sqlserver/sqlserver-adapter.ts` |
| SQL Server `sp_rename`／`sp_settriggerorder` 字面值補 `N` 前綴 | 三個 service |
| EventBus listener 例外蓋掉已成功的命令結果 | `event-bus.ts` |
| script／export 服務 finally 內 audit 例外使 job 卡住、暫存檔不清 | `sql-script-service.ts`、`sql-export-service.ts` |
| `mcp.rotate_token` 與 gateway 重啟並行 | `index.ts` |
| MCP Host／Origin 檢查不接受 IPv6 `::1` | `mcp-server.ts` |
| `McpStopped` 後 pending 核准仍可被批准 | `permission-service.ts` |
| audit 記錄 UI 檢視狀態指令（`workspace.update`／`activate`／`reorder`） | `command-bus.ts` |
| workspace.json 每次按鍵同步寫入，改為 300ms debounce 並於退出時 flush | `workspace-service.ts`、`index.ts` |
| workspace 事件每次都帶全部結果集，改為只送有變更的結果（`resultVersion`） | `workspace-service.ts`、`App.tsx` |
| `QueryView` 的 `pageKey` 因事件而換 identity，重設選取與對話框 | 同上（結果物件沿用） |
| ✕／Cancel 繞過放棄未儲存變更確認 | `ConnectionForm`、`SettingsPanel`、`InsertRowDialog` |
| 排序時未將 offset 歸零 | `TableView.tsx` |
| 歷史重跑的唯讀判斷放行 `EXPLAIN ANALYZE`、`SELECT ... INTO` | `App.tsx` |
| `TableView` 不處理 `TableStructureChanged`，主鍵與欄位過期 | `TableView.tsx` |
| 缺少 ErrorBoundary | `components/ErrorBoundary.tsx` |

驗證：`npm run typecheck` 通過；`npm test` 495 通過、122 跳過（需真實資料庫）。桌面 smoke 與整合測試未執行。

## 待辦（依建議順序）

### 效能

1. **PG／MySQL 非 readOnly 查詢每次 destroy 連線**（`postgres-adapter.ts:195`、`mysql-adapter.ts:216`）：瀏覽資料、翻頁每次重做 TCP、TLS、認證。已知為單一 `read` SELECT 時，改走唯讀交易後回收連線。需先確認風險判斷可靠，並以整合測試驗證。
2. **Sybase 每次查詢新開 JVM**（`sybase-adapter.ts:390`、`jdbc-session.ts:289`、`AseQuerySession.java:184,227`）：預編譯成 `.class` 並以 `-cp` 執行；metadata 查詢重用 session 或做小型 pool；限制並行數；移除前後兩次 `checkCharset` 往返。`aseColumns` 一次要 3 到 5 個 JVM。
3. **PG 文字協定對 UTF8 也全量轉換**（`postgres-adapter.ts:62`、`text-protocol.ts`）：charset 為 UTF8 時不安裝 `EncodedConnection`。另外每列重算欄位名與 `assertUniqueColumns`（`:170`），改為只在第一列處理。
4. **renderer 重渲染**：各 View 加 `React.memo`，穩定 `onRun`／`onStop`／`readOnly`／`busy` 等 props（`App.tsx` 分頁迴圈）。`DatabaseExplorer` 物件清單虛擬化、搜尋 debounce、`showSchema` 以 `useMemo` 計算（`DatabaseExplorer.tsx:772`）。
5. **多餘 IPC**：`App.tsx` 的 `tables` state 只寫不讀，`changeScope` 的 `table.list` 可移除；`DatabaseNode` 逐 schema 串行 `table.list` 改 `Promise.all`（`DatabaseExplorer.tsx:409`）；事件重整只更新受影響節點。
6. **MCP `McpToolCatalog` 每次 list／call 重建約 90 個 zod schema**（`tool-catalog.ts:204`）：依 `agentLevel` 快取，`SettingsChanged` 時失效。
7. **SecureStorage 每次加解密多做一輪探測**（`secure-storage-service.mjs:76`）：成功後短時間內不重測；`AuditService` 的 cache 只在連線 id 集合或密碼實際變動時失效。
8. **audit 其他成本**：`list()` 每次對全部 entry 做 `JSON.stringify().toLowerCase()`；`record()` 仍整檔重寫，可改 JSONL append（`audit-service.ts`）。
9. **SQL 腳本解析**：`start()` 先 `units()` 再 `risks()` 重複切分，改為傳入 units；MySQL 先以輕量預檢再 token 化；`words` 只保留前 4 個與最後 2 個（`sql-script-parser.ts:56,243`、`sql-script-service.ts:96`）。
10. **查詢歷史**：SQL 無長度上限、每次讀寫整份 JSON；截斷（例如 8 KiB）並改 append 或 debounce（`query-service.ts:157`）。
11. **workspace 事件的 `selectedRows`**：仍隨每次事件帶出，TableView 勾選大量列時可考慮同樣瘦身。
12. **renderer 打字 debounce**：`sql`、`dirty` 的 `workspace.update` 目前每按鍵一次。需先釐清 `SqlEditor` 的 `sent` 回聲邏輯與 Run 使用 `tab.sql` 的耦合，確保 Run 取得最新 SQL，才能安全 debounce。

### 正確性與可靠性

13. **PG／MySQL script session 取消沒有 server 端取消**（`postgres-adapter.ts:28`、`mysql-adapter.ts:33`）：逾時或取消後語句可能照常提交。先以另一條連線送 `pg_cancel_backend(pid)`／`KILL QUERY id` 再 destroy。
14. **MySQL `replaceObject` 逾時復原**（`mysql-adapter.ts:112`）：`dropped` 只在 await 成功後設定，DROP 逾時但 server 已執行時不會還原。
15. **Redis 單一不可解碼 key 使整批 SCAN 失敗**（`redis/text-codec.ts:49`）：讀取端改回傳標記值（例如 base64 或 `\xNN`），寫入端保持嚴格。
16. **`query.read` 翻頁重跑整個查詢並略過 offset 列**（`query-service.ts:55`、`network/common.ts:48`）：成本隨頁數二次成長，無 `ORDER BY` 時漏列或重複。改保留伺服器端 cursor／keyset，或警告無排序的分頁。
17. **表格瀏覽無排序時分頁不穩；`columns: []` 產生 `SELECT  FROM`**（`sql-builder.ts:81,110`）：無 `sort` 時退回主鍵或 rowid；空 columns 視同 `*`（`||` 取代 `??`）。
18. **`JsonStore` 遇損毀檔案**（`store.ts:13`）：settings 損毀使開機失敗、audit 損毀使稽核靜默停止。改名為 `.corrupt-<time>` 並回傳初始值，稽核失敗時通知 UI。
19. **`ConnectionService.save` 副作用先於持久化**（`connection-service.ts:69`）：`store.write` 失敗時密碼已被覆寫、分頁已關閉。先寫 store，成功後再寫密碼並呼叫 `beforeDisconnect`。
20. **`columnClause` 多處漏傳 `noBackslash`**（`table-structure-service.ts:430,463,639`、`structure-properties.ts:332,375`、`generated-columns.ts:90,210,244`）：MySQL `NO_BACKSLASH_ESCAPES` 下含反斜線的預設值使該表無法編輯。
21. **`sqlTokens` 對所有引擎把 `[` 當引號**（`object-sql.ts:69`）：PG 的 `ARRAY[ARRAY[..]]` 被誤擋，僅在 `sqlserver`／`sybase`／`sqlite` 視為引號。
22. **SQLite 名為 `trigger` 的表或欄位被誤判為 trigger 語句**（`sql-script-parser.ts:244`）：只在 `words[1]`（或 `TEMP` 後的 `words[2]`）為 `TRIGGER` 時設定。
23. **SQLite 排隊請求取消後要等前一個請求結束**（`sqlite-adapter.ts:169`）：入佇列時就註冊 abort。
24. **Sybase 匯出 `finally` 內 ROLLBACK 失敗蓋掉原始錯誤**（`AseDataExport.java:271`）。
25. **Agent 名稱取自客戶端自報的 `clientInfo.name`**：目前僅用於顯示與稽核，若日後核准 UI 以名稱辨識來源，需另行處理。

### renderer 行為

26. **重新整理 explorer 或切換連線會卸載 Dialog**（`DatabaseExplorer.tsx:166`、`App.tsx:150`）：進行中的匯出或腳本被放掉，展開狀態遺失。Dialog 提升到 App 層，重新整理改就地更新，保留 `key={database}`。
27. **`TableView` 儲存或刪除後重複載入兩次**（`TableView.tsx:133`）：effect 依賴 `busy`。
28. **背景重載時篩選 Fieldset 被 disabled**（`TableView.tsx:233`）：打斷輸入，篩選面板移出 Fieldset。
29. **紀錄面板切換時未清空舊資料，Refresh 無競態防護**（`App.tsx:229,737`）。
30. **`ExplorerTable` 欄位樹在結構變更後過期**（`ExplorerTable.tsx:31`）：事件時清空 `columns`，並防止重複 `expand()`。

## 驗證建議

修改資料庫相關項目（1、2、13、14、16）時，依 [使用指南](../USER_GUIDE.md) 的「真實資料庫整合測試」執行 `npm run integration:up` 與對應 smoke test，再 `npm run integration:stop`。
