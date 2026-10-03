# 新增資料庫支援：功能與實作規格

文件日期：2026-09-28。依目前 Database Workspace 原始碼、既有功能及 Code Review 修正整理。

本文件可作為新增資料庫引擎的開發規格、工作清單與交付驗收依據。尚未指定目標引擎，因此不預設其語法、認證方式、版本或 DDL 交易能力；實作時必須以目標版本的官方文件及真實資料庫測試確認。

## 1. 完成標準與適用範圍

「支援新資料庫」不能只做到連線成功或執行 `SELECT 1`。使用者應能完成連線、選取資料庫、瀏覽物件、讀寫資料、管理適用的物件、使用 GUI／MCP，並在中斷、失敗及未儲存狀態下維持正確行為。

| 分類       | 要求                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| 必要       | 所有引擎都必須具備：連線生命週期、範圍隔離、資料瀏覽、適合其資料模型的操作、權限、稽核、資源限制、錯誤處理及測試。        |
| 依能力提供 | 引擎／版本／認證模式支援時必須整合；不支援時應標示原因，後端也須拒絕呼叫。例如 SQL 物件、EXPLAIN、多 database、DDL 交易。 |
| 進階選配   | 超出目前產品基本功能，可另開迭代；不得混入首版的完成承諾。                                                                |

SQL 引擎以 Table／View／Trigger／Index 的基本新增、修改、刪除為目標，共 12 項操作。引擎原生不提供的物件可註記「不適用」，不得以空列表、空實作或成功訊息偽裝已支援。

非 SQL 引擎應使用自身的物件與操作模型，例如 collection／document 或 key／value。沿用共用 Command Bus 與權限流程，但不能強行套用 SQL 物件設計器。若僅交付讀取功能，必須明確標為「唯讀支援」，不能宣稱完整支援。

## 2. 開發前必填：引擎能力表

建立該引擎的實作紀錄，逐項填入「支援／受限／不支援／不適用」與驗證依據。認證模式或伺服器版本有差異時，應分列，不可只測一種模式便推論全部適用。

| 調查項目       | 必填內容                                                                  |
| -------------- | ------------------------------------------------------------------------- |
| 引擎識別       | `Engine` 代碼、顯示名稱、SQL 或其他資料模型；是否真正可沿用現有 adapter。 |
| 版本           | 最低支援版本、實際驗證版本、版本間功能差異。                              |
| 平台           | Windows／macOS／Linux 與 CPU 架構的支援及實測狀態。                       |
| 驅動           | 套件及版本、授權、Node／Electron 相容性、原生依賴、封裝方式。             |
| 認證           | 帳密、作業系統身分、憑證或其他模式；各自需要的欄位與限制。                |
| 連線           | 預設連接埠、主機／實例／檔案格式、TLS、連線與查詢逾時。                   |
| 命名範圍       | server／catalog／database／schema／namespace 對應；預設範圍如何決定。     |
| 識別字         | 大小寫規則、引用與跳脫、保留字、Unicode、名稱長度及計量單位。             |
| SQL 方言       | 參數占位符、分頁、預設列 INSERT、單敘述辨識、EXPLAIN。                    |
| 型別           | 可讀寫型別、精確序列化方式、長度／precision／scale 限制。                 |
| 物件操作       | Table／View／Trigger／Index 的查詢、新增、修改、刪除與版本限制。          |
| 交易與 session | DDL 是否原子、隱含提交、取消與回滾行為、session 重設方式。                |
| 權限           | 列舉 metadata、讀取定義、讀寫、建立資料庫及各 DDL 所需權限。              |
| 已知限制       | 不支援的型別／選項、可用替代流程、測試案例與文件連結。                    |

現行程式尚無集中式 capability registry，許多差異分散在 `engine` 分支中。若本次需要新增能力描述模型，須同時設計主程序驗證及 GUI 顯示，不能只新增前端旗標。這是可採用的重構方向，並非現有 API。

## 3. 架構與實作位置

資料操作必須遵循既有路徑：

```text
GUI → 固定 preload／IPC bridge ─┐
                              ├→ Application Command Bus
MCP → MCP Gateway ─────────────┘     → 輸入驗證／權限／核准／稽核
                                    → Application Services
                                    → Database Adapter → Driver → Database

操作結果 → 共用事件 → 瀏覽器／資料頁／分頁狀態更新
```

Renderer 不得直接載入資料庫驅動、取得密碼或建立資料庫連線。MCP 不得另建一套繞過 GUI 權限與服務的資料操作。

### 3.1 必須盤點的修改點

下表是修改入口，不表示所有檔案都必須變更；每個入口都應確認是否存在新引擎的缺漏或不適用的預設分支。

| 層級                 | 主要檔案                                                                                                                                                                                                                                             | 檢查內容                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 共用型別             | `src/shared/types.ts`                                                                                                                                                                                                                                | Engine、Connection、TableRef、Column、QueryResult；新增原生模型時的共享型別。 |
| 輸入驗證             | `src/shared/schemas.ts`、`create-object.ts`、`drop-object.ts`                                                                                                                                                                                        | 引擎列舉、認證／連線欄位、DDL 表單、資料值表示法。                            |
| Adapter              | `src/main/database/adapter.ts`、`factory.ts`、`adapters/`                                                                                                                                                                                            | 驅動建立、連線、查詢、取消、metadata、DDL 執行與清理。                        |
| 共用網路 adapter     | `src/main/database/adapters/network/common.ts`                                                                                                                                                                                                       | 可重用的結果正規化與 metadata；現有分支不一定適用新引擎。                     |
| SQL 產生與解析       | `src/main/database/sql-builder.ts`、`create-database.ts`、`structure-sql.ts`、`object-sql.ts`                                                                                                                                                        | 引用、占位符、分頁、型別片段、DDL 與物件標頭解析。                            |
| SQL 風險判定         | `src/main/security/sql-policy.ts`、`single-statement.ts`                                                                                                                                                                                             | 正確 dialect、單敘述邊界、未知語法保守處理。                                  |
| 連線／查詢／資料服務 | `src/main/application/services/connection-service.ts`、`query-service.ts`、`data-service.ts`                                                                                                                                                         | scope、連線設定變更、cursor、原始列條件、事件。                               |
| 物件服務             | `database-metadata.ts`、`table-structure-service.ts`、`create-object-service.ts`、`database-object-service.ts`、`drop-object-service.ts`，均位於 `src/main/application/services/`                                                                    | 物件列舉、完整定義、預覽、版本檢查、套用、刪除及相依物件。                    |
| 命令／MCP            | `src/main/application/application.ts`、`commands/command-bus.ts`、`src/main/mcp/server/mcp-server.ts`                                                                                                                                                | 既有命令的引擎能力驗證；新增命令的 schema、風險、可見性與 resource。          |
| 權限／稽核           | `src/main/mcp/permissions/permission-service.ts`、`audit/audit-service.ts`、`src/main/security/redact.ts`                                                                                                                                            | 核准範圍、撤銷、遮罩、新認證資料不得外洩。                                    |
| GUI 入口             | `src/renderer/src/App.tsx`、`components/ConnectionForm.tsx`、`DatabaseExplorer.tsx`、`WorkspaceScope.tsx`                                                                                                                                            | 引擎選項、預設值、狀態、樹狀清單、路徑與操作選單。                            |
| GUI 編輯器           | `src/renderer/src/components/` 下的 `QueryView.tsx`、`SqlEditor.tsx`、`TableView.tsx`、`TableDesigner.tsx`、`StructureEditor.tsx`、`CreateObjectView.tsx`、`DatabaseObjectView.tsx`、`DropObjectDialog.tsx`、`InsertRowDialog.tsx`、`CellEditor.tsx` | 新方言、編輯能力、草稿、精度、物件操作與錯誤。                                |
| 型別／語言           | `src/renderer/src/column-types.ts`、`components/ColumnTypeEditor.tsx`、`zh-TW.json`                                                                                                                                                                  | 型別 autocomplete、參數控制項、繁中／英文文案。                               |
| 測試／封裝           | `tests/`、`scripts/`、`compose.integration.yml`、`package.json`、`package-lock.json`                                                                                                                                                                 | 測試配置、隔離環境、測試 runner 納入、新驅動及原生檔案封裝。                  |

特別注意：目前 `SqlBuilder` 的預設分支會使用雙引號、`?`、`LIMIT/OFFSET`。新增 Engine 後若未顯式處理，TypeScript 可能仍可通過，但產生的 SQL 不一定正確。物件服務中的「其他引擎」分支亦須逐一檢查。

### 3.2 現有 SQL Adapter 契約

以 [adapter.ts](../src/main/database/adapter.ts) 為準：

| 方法                                         | 必須實現的語意                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `connect()`                                  | 建立真實可用的連線；失敗清理已建立資源；由 ConnectionService 協調並行連線。                                               |
| `disconnect()`                               | 釋放連線池、游標與驅動資源；可安全重複呼叫。                                                                              |
| `query(sql, params, options)`                | 正確綁定參數，遵循 `limit`、`offset`、`timeout`、`readOnly`、`signal`，回傳一致 QueryResult。                             |
| `databases()`                                | 列出帳號可存取的 database；無此層級者使用明確定義的替代映射。                                                             |
| `schemas()`                                  | 列出目前 database 的 schema／namespace。                                                                                  |
| `tables(schema?)`                            | 正確區分 table／view，保留其實際 schema。                                                                                 |
| `describe(ref)`                              | 欄位順序、完整型別、nullable、defaultValue、primaryKey。                                                                  |
| `executeDdl?(statements, timeout, options?)` | 型別上可選；啟用物件設計功能時需實作，或調整服務提供等效執行能力。只接收服務產生的內部計畫，相關敘述在同一 session 執行。 |

`executeDdl` 的 `rebuildTable`／`validateViews` 是既有引擎特定選項；新 adapter 必須明確處理或拒絕，不得默默忽略影響正確性的選項。不能僅依「driver 可以執行多個 SQL」推論 DDL 計畫具原子性。

## 4. 使用者功能規格

### 4.1 連線與生命週期【必要】

- 新增／編輯／刪除連線，提供必要的認證、連線及 TLS 欄位；無關欄位隱藏或停用並解釋。
- 測試連線使用暫時資源，完成後釋放；不應因此建立正式瀏覽器狀態或保存尚未儲存設定。
- GUI 冷啟動所有連線離線、灰燈，顯示雙擊提示；單擊選取，雙擊／Enter 建立連線，過程顯示連線中狀態。
- 成功後才載入資料庫列表；失敗可辨識原因並重試，不殘留假連線狀態。
- 中斷時取消執行中查詢、釋放所有 database scope、清空瀏覽器、關閉相關分頁；其他連線不受影響。
- 有草稿時先確認；取消必須保留連線、分頁與草稿。明確中斷後，晚到回應、舊 adapter 及背景請求不得自動恢復連線。
- 連線尚在建立時也可中斷；之後才建立完成的 driver 連線必須釋放。
- 修改名稱、顏色、群組、最愛等顯示設定不重建連線。變更 host、port、database、TLS 或認證時，先處理草稿，再關閉舊 scope。
- 新增連線欄位後，也要更新「哪些設定變更需要重連」的比較邏輯。
- 刪除連線同時清理設定、憑證及相關分頁，不留下重啟後無法使用的孤立分頁。

GUI 的啟動離線規則與 MCP 的主動資料操作需分開驗證。現有 MCP 可由共用服務為主動請求建立連線，但明確中斷後須先 `connection.connect`，不可繞過此狀態。

### 4.2 資料庫瀏覽器與範圍【必要；建立資料庫依能力】

- 列出可存取的 database／schema，以及適用的物件群組；支援展開、搜尋、重新整理、空清單、載入中及錯誤狀態。
- 支援列舉目前未選取的資料庫，選取後每個分頁保存自己的 database／schema；不得隨瀏覽器選取而改寫舊分頁的操作目標。
- `connectionId + database + schema + object` 應能區分同名物件；資料庫不是必然存在 schema 層，需在能力表寫明映射。
- 路徑顯示避免 database／schema 語意相同時重複；但兩者只是名稱相同、實際為不同層級時不可任意刪除。
- 每個 scope 的 pool／session 必須隔離。`USE`、`SET`、暫存表、預設 schema 或交易不得污染其他 scope。
- 若採無狀態查詢，操作結束需可靠重設或銷毀有狀態的 session；若規劃跨次交易，需另設專屬 session 與生命週期，不能沿用共享 pool 假裝支援。
- 支援建立 database 的引擎應提供 ＋／表單／錯誤提示，成功後刷新清單；檔案型或伺服器配置型引擎提供相應流程，不能硬套 `CREATE DATABASE`。
- 權限不足、無物件與不支援功能是不同狀態，不得全部以空列表表示。

### 4.3 查詢【SQL 必要；EXPLAIN 依能力】

- 開啟獨立查詢分頁、執行選取內容、快捷鍵、結果表格、查詢紀錄、取消與逾時。
- 更新解析器 dialect 與單敘述檢查，涵蓋字串、註解、引用識別字及引擎特有 SQL 主體；不可單純以分號切割。
- `query.read` 僅接受已驗證的唯讀查詢。未知函式、寫入 CTE、鎖定讀取或無法判定的語法不能放行為 read。
- `readOnly` 必須對應實際行為；若驅動／引擎無法提供唯讀交易，需明確定義並測試其他防護，不可把旗標當成伺服器已保證唯讀。
- EXPLAIN 不能意外執行帶副作用的分析；需要 session 選項時使用隔離 session 並清理。
- 結果遵循筆數、大小與逾時限制；取消後不得繼續收集資料或占用失效連線。
- 目前查詢下一頁是重新執行並略過前面資料，並非交易快照。新引擎應保持契約；若改用原生 cursor，需明確擴充服務與資源釋放流程。
- `affectedRows` 必須定義並驗證 matched／changed／trigger 計數差異；不得讓相同值更新被 GUI 誤判為原始列消失。

QueryResult 欄位需完整且語意一致：`columns`、`rows`、`rowCount`、`affectedRows`、`duration`、`hasMore`。`nextCursor` 由共用查詢流程管理，不能回傳未受權限與 scope 約束的原生 handle。

### 4.4 資料列讀寫【可寫 SQL 引擎必要】

| 操作       | 要求                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| 讀取       | 欄位選取、篩選、排序、分頁；綁定所有資料值，識別字獨立引用。                                                       |
| 新增       | 區分省略、NULL、空字串與實際值；省略交由資料庫套用預設／自動產生值；全部省略亦可執行預設列 INSERT。                |
| 修改       | GUI 以原始主鍵或複合主鍵定位；修改主鍵值仍用原始鍵作 WHERE。無可靠列識別時禁止直接編輯。                           |
| 刪除       | 以明確列條件刪除，顯示影響並遵循 delete／destructive 政策；不得產生無條件 DELETE。                                 |
| 草稿       | 載入期間禁止對舊結果新增編輯；已輸入但尚未失焦的文字也不能被外部刷新覆蓋。                                         |
| 並行與失敗 | 晚到結果不能將草稿移到另一列；零列更新、約束錯誤、連線失敗保留尚未提交內容。部分成功需精確顯示已提交與待處理列數。 |

既有 GUI 儲存是逐列提交，不能宣稱整批原子。原始主鍵保護也不等同完整樂觀鎖：若需偵測同一列被其他人改值，應另設版本欄位或完整前值比對功能。

### 4.5 型別與數值保真【必要】

| 類型                 | 表示與驗證要求                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| INTEGER／BIGINT      | 超出 JS 安全整數範圍時以精確文字或明確無損表示傳輸；主鍵條件不能先轉 Number。                                |
| DECIMAL／NUMERIC     | 在 driver 解碼時保留精度與小數位數；轉成 Number 後再 String 無法恢復精度。讀取、編輯、參數綁定均需往返測試。 |
| FLOAT／DOUBLE        | 保留近似數值語意，定義非有限數值的拒絕／表示方式，不能讓 JSON 序列化靜默改值。                               |
| BOOLEAN／NULL／文字  | false、0、NULL、空字串必須可區分，不能依 truthy／falsy 轉換。                                                |
| 日期與時間           | 明確定義時區、無時區值、精度及往返格式；不可無提示截斷或改變時間。                                           |
| Binary／LOB          | 定義編碼及讀寫是否對稱；目前 Buffer 結果使用 base64，不代表寫回字串會自動解碼。大型值必須符合回應限制。      |
| JSON／陣列／特殊型別 | 規範格式、可編輯範圍及大數字保真；不支援寫入時標示唯讀原因。                                                 |

目前 `valuesSchema` 僅接受 string／有限 number／boolean／null。若新引擎需要巢狀文件、binary 或具型別參數，需同步擴充 schema、IPC／MCP、服務、driver 綁定與 editor；不要直接以 `any` 或隱含字串化繞過契約。

同一引擎的不同認證驅動可能有不同解碼行為。現有 SQL Server 的 Tedious 與 Windows msnodesqlv8 精度差異已證實此點，必須逐模式測試。無法保證無損時應明確拒絕／限制，並標為「受限支援」，不可通過完整型別驗收。

### 4.6 Table／View／Trigger／Index【依原生能力，SQL 首版基本範圍】

| 物件    | 新增                                                          | 修改                                                                      | 刪除                                                   |
| ------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------ |
| Table   | 名稱、schema、欄位、型別、參數、NULL、預設值、單一／複合 PK。 | 新增／移除欄位、改欄位名稱／型別／NULL／預設值、修改 PK；保留不相關結構。 | 預覽 SQL、所屬物件與受影響分頁，確認後 DROP。          |
| View    | 名稱、schema、SELECT 定義。                                   | 讀取完整定義，預覽與套用修改。                                            | 預覽後 DROP；處理依賴與權限錯誤。                      |
| Index   | 目標表、欄位及順序、ASC／DESC、UNIQUE（依引擎能力）。         | 讀取定義並修改，必要時重建，清楚揭露原子性。                              | 正確引用索引及所屬表，不把約束管理索引當普通索引刪除。 |
| Trigger | 目標、事件、時機、主體；函式或 routine 型引擎需定義相應流程。 | 取得可還原的完整定義，保留引擎需要的選項與停用狀態。                      | 正確定位目標，不能連帶刪除可能共用的函式。             |

四類操作共同要求：

- 有完整入口及相應分頁／對話框，涵蓋群組 ＋、右鍵操作與開啟既有物件。
- Table 設計器選取欄位即可修改；型別 autocomplete 依引擎，長度／precision／scale 分開控制；NULL 可快速切換，PK 可多選。
- 型別參數須依實際語意提供，不能把所有整數都視為可設定顯示寬度，或將長度與 precision 混為一談。
- SQL 預覽與執行使用同一份服務計畫；預覽不可寫入資料庫。
- 套用前重新讀取定義並比對版本，過期預覽不得直接覆蓋外部變更。
- DDL 是否原子、是否隱含提交、重建空窗及失敗恢復策略必須明確呈現；不能宣稱所有引擎可回滾。
- 無法完整讀取或無法安全保留的結構應限制編輯，不能重建後靜默刪掉 FK、CHECK、generated 欄位或特殊選項。
- 不自動 CASCADE；遇到相依性回報可理解的原因。成功刪除才關閉相關物件分頁，失敗保留。
- 成功後刷新樹狀列表與相關 metadata。結構變更提示放於工具列、可點開浮動細節，不推動編輯區位置。

### 4.7 非 SQL 引擎的對應要求

若新增的資料庫不適用 SQL，除共用連線、權限、scope 與工作區要求外，需列出自己的功能矩陣：

- namespace／database／collection／key 的瀏覽、搜尋、游標分頁與計數；精確值、估算值、未知值應區分。
- 原生物件或資料型別的讀取、新增、修改、刪除及生命週期；不可一律當作 string。
- 文件巢狀值、大數字、二進位、集合順序與重複元素等語意要保留。
- TTL、過期、stream append、索引或其他特有操作，依引擎提供明確命令與風險分類。
- 未載入外掛、版本不支援與帳號無權限應分別回報；未知型別可提供 metadata／唯讀檢視，但不能用錯誤的 editor 寫回。
- 自訂服務與 editor 仍透過既有 Command Bus；SQL 專用入口應隱藏或停用，後端也須拒絕。

現有 Redis adapter 雖放在共用 factory 中，但 RedisService／RedisView 使用其專屬資料模型；這不是要求新非 SQL 引擎假裝能實作 SQL。

## 5. 命令、權限與事件整合

### 5.1 應覆蓋的命令族

| 功能       | 現有命令                                                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 連線       | `connection.list`、`connection.status`、`connection.statuses`、`connection.test`、`connection.save`、`connection.delete`、`connection.connect`、`connection.disconnect` |
| Metadata   | `database.list`、`database.create`、`schema.list`、`table.list`、`table.describe`、`index.list`、`trigger.list`                                                         |
| 查詢／資料 | `query.validate`、`query.read`、`query.execute`、`query.next`、`query.cancel`、`data.select`、`data.insert`、`data.update`、`data.delete`                               |
| 結構／物件 | `structure.describe/preview/apply`、`object.create_preview/create`、`object.describe/preview/apply`、`object.drop_preview/drop`                                         |
| 工作區     | `app.open_query`、`app.open_table`、`app.open_object`、`app.open_create_object` 及既有 workspace 命令                                                                   |

上表列的是 Application 命令，不表示全部都應開放成 MCP tool。`connection.save/delete/test` 等現有 humanOnly 邊界需保留；透過真實 MCP 測試確認可見性及拒絕行為。非 SQL 引擎可新增對應命令，但仍共用註冊與驗證機制。

### 5.2 權限與安全契約【必要】

- 每項命令明確分類為 read、workspace、insert、update、delete、ddl 或 destructive，不能將不認識的 SQL 當 read。
- 同時遵守連線 `agentAccess`、Observe／Assist／Execute 及 Allow／Ask／Deny 政策；GUI 與 MCP 使用同一服務。
- DDL 核准綁定完整驗證後輸入，包含引擎連線範圍、物件名稱、類型與定義；內容改變須重新核准。破壞性操作不可沿用十分鐘授權。
- 連線／政策變更、MCP 停止時遵循既有撤銷流程；過期 cursor 與跨連線／跨 Agent 存取需拒絕。
- 密碼／token／私鑰使用既有 Credentials 服務或等效安全儲存，不進 renderer、workspace、history、audit 或錯誤訊息。
- 資料值使用參數綁定；識別字與 DDL 片段獨立驗證。不要用字串拼接取代 parameter binding。
- TLS 驗證不可默默降級或關閉。需要新增設定時同步設計 UI、驗證與文件。
- GUI／MCP 結果受相同大小、筆數、逾時限制；不得以新引擎為理由繞過既有治理。

### 5.3 事件與工作區

沿用相同操作的既有事件及 payload 範圍，例如 `ConnectionChanged`、`QueryStarted`、`RowInserted`、`RowUpdated`、`RowDeleted`、`DatabaseObjectCreated`；其他結構／刪除事件以 Application 當前定義為準。新原生操作若需要新事件，須一起實作接收端。

資料或結構變更只刷新同一連線／database／schema／物件的頁面。成功、失敗與取消均要終結 loading／busy 狀態；晚到結果不得復活已關閉分頁或覆蓋草稿。重啟還原工作區不得自行建立 GUI 連線。

## 6. 驗收測試

不能只使用 mock，也不能只在 SQL 編輯器手動試一次。每項適用功能至少要有服務／adapter 層證據，關鍵操作另需 Electron 桌面及 MCP 證據。

| 編號 | 測試情境                                                              | 必須成立的結果                                               |
| ---- | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| C01  | 冷啟動、雙擊、錯誤帳密、重試、連線中取消                              | 狀態正確，資源可釋放，晚到連線不復活。                       |
| C02  | 中斷與刪除；含乾淨／髒分頁及多個 database scope                       | 確認取消不破壞草稿；確認捨棄後只清理相關範圍；無孤立分頁。   |
| C03  | 名稱／顏色變更與端點／認證變更                                        | 前者保留連線、後者先保護草稿；新認證欄位也觸發正確重連規則。 |
| S01  | 兩個 database／schema 同名表，交錯及並行讀寫                          | 目標不混用，路徑與 audit 範圍一致。                          |
| S02  | USE／SET／交易或引擎等效 session 變更                                 | 不污染下一操作／其他分頁，符合已宣告 session 模型。          |
| M01  | Unicode／保留字／含引用符的名稱、空庫、metadata 權限不足              | 正確引用並區分空、拒絕與不支援。                             |
| Q01  | 查詢／取消／逾時／網路中斷／重新連線                                  | 無卡住的 busy、無資源洩漏、可恢復正常操作。                  |
| Q02  | 超過筆數／大小限制，下一頁、過期及跨 actor cursor                     | 截斷和 hasMore 正確，cursor 不越權，不宣稱固定快照。         |
| D01  | 新增／讀取／修改／刪除、單鍵與複合鍵、修改主鍵                        | 只影響原始目標列，資料值正確綁定。                           |
| D02  | 全部省略、自動編號、預設值、NULL、空字串、false、缺少必填欄位         | 成功與約束錯誤符合資料庫語意，失敗保留草稿。                 |
| D03  | 慢速刷新時編輯、輸入尚未失焦、外部刪除／改動、部分儲存失敗            | 不移動／遺失草稿；零列與部分成功正確回報。                   |
| T01  | BIGINT 邊界、最大 precision／scale、負數／零／NULL、小數主鍵往返      | 沒有 Number 捨入、截斷或錯誤定位；每種認證驅動各測。         |
| T02  | 時區、日期精度、binary、JSON／大型值                                  | 格式與精度符合規格；受限型別明確拒絕。                       |
| O01  | 四種物件各自新增→讀取→修改→刪除                                       | 所有宣告支援的操作成功；重名、權限與原生語法錯誤可恢復。     |
| O02  | 複合 PK、欄位改名／型別／NULL／預設值、trigger 實際觸發、unique index | metadata 與實際效果一致，不只驗證 SQL 字串。                 |
| O03  | 過期定義、DDL 中途失敗、相依物件、特殊／約束管理索引                  | 不覆寫外部變更、不靜默丟結構；回滾／恢復符合引擎能力。       |
| A01  | Observe／Assist／Execute、唯讀連線、Allow／Ask／Deny、humanOnly       | GUI／MCP 同樣受控，沒有替代路徑繞過。                        |
| A02  | 核准後改名稱／種類／欄位／定義，政策撤銷與過期                        | 不沿用不匹配授權；重複破壞性操作仍須核准。                   |
| U01  | 所有入口、型別控制項、NULL／多 PK、分頁切換／重啟還原                 | 支援狀態一致，草稿受保護，路徑不重複，提示不推動布局。       |
| P01  | 宣告支援的平台及安裝包                                                | 無開發依賴的封裝程式可載入 driver、連線、讀寫、取消與中斷。  |

### 6.1 執行方式

沿用現有命令，並將新引擎測試加入適當 runner，而非只增加不會執行的檔案：

```sh
npm run typecheck
npm test -- --maxWorkers=1
npm run integration:up
npm run test:integration -- --maxWorkers=1
npm run build
```

建置後依修改範圍執行既有桌面回歸，並新增目標引擎的隔離 smoke test：

```sh
node scripts/smoke-connections.mjs
node scripts/smoke-scopes.mjs
node scripts/smoke-create-objects.mjs
node scripts/smoke-structure.mjs
node scripts/smoke-object-tabs.mjs
node scripts/smoke-review-fixes.mjs
```

這些既有腳本不一定涵蓋新引擎，需檢查其連線配置與斷言後擴充；個別腳本的額外平台／服務前置條件也須確認。新引擎若不在 Docker Compose 中，應提供等效的專用測試環境說明。

測試完執行 `npm run integration:stop`。發行前另執行 `npm run package`、`npm run test:packaged`，並在實際發行包中加入新引擎驗證。只通過 `npm run build` 不代表 driver 已正確封裝。

測試資料使用隔離暫存目錄或專用測試服務；資源名稱帶隨機字尾並在 finally 清理。不得使用使用者業務資料作破壞性驗收。`.local/integration.env` 憑證不可輸出或寫入報告。測試報告須分列通過、失敗、略過及未驗證平台，不能把略過算成支援。

## 7. 建議實作順序與交付閘門

| 階段          | 交付內容                                     | 進入下一階段前的證據                                     |
| ------------- | -------------------------------------------- | -------------------------------------------------------- |
| 1. 調查       | 能力表、版本／認證矩陣、範圍映射、限制       | 官方依據及驅動連線／型別保真探針；先找出不能承諾的功能。 |
| 2. 接入       | 共用型別、schema、factory、adapter、連線表單 | 真實連線／中斷、錯誤清理、設定保存與舊設定相容。         |
| 3. 查詢與瀏覽 | metadata、方言、風險判定、範圍與分頁         | 同名物件隔離、取消／逾時、唯讀與回應限制。               |
| 4. 資料讀寫   | SQL builder／原生服務、型別表示、資料 editor | CRUD、預設列、主鍵／小數往返及草稿並行回歸。             |
| 5. 物件管理   | 全部適用的 create／edit／drop 與設計器       | 真實 DDL 效果、版本衝突、相依性與失敗恢復。              |
| 6. 完整整合   | MCP、事件、工作區、文案、套件封裝            | 桌面與 MCP 流程、權限矩陣、安裝包、相容性回歸。          |
| 7. 發布紀錄   | 支援矩陣、限制、驗證證據與操作文件           | 所有必要項已完成；任何受限功能均可見且未被宣稱完整。     |

### 7.1 可勾選的交付清單

- [ ] 已填寫第 2 節能力表，列明引擎版本、平台及各認證模式。
- [ ] 已完成 Engine／schema／factory 接入，並盤點所有引擎分支與預設 fallback。
- [ ] 已完成連線測試、生命週期、草稿保護及憑證清理。
- [ ] 已完成 database／schema／namespace 與分頁 scope 隔離。
- [ ] 已完成 metadata、查詢或原生操作、取消、逾時及結果上限。
- [ ] 已完成適用的資料 CRUD，值綁定及型別精度往返驗證。
- [ ] 已完成適用的 Table／View／Trigger／Index 12 項操作，或逐項記錄不適用原因。
- [ ] 已完成型別 autocomplete、參數控制、NULL／複合 PK 及草稿 UI。
- [ ] 已完成 GUI／MCP 共用命令、權限、核准範圍、稽核與事件更新。
- [ ] 已完成真實資料庫、桌面、MCP 與既有引擎回歸測試。
- [ ] 已完成宣告支援平台的發行包 driver 驗證。
- [ ] 已更新 README、IMPLEMENTATION、能力矩陣、測試結果與已知限制。

不在首版基本要求中的功能：資料庫／物件重新命名、資料庫刪除、FK／CHECK 專用設計器、分割表、物化檢視、全文／空間索引專用選項、使用者／角色管理、備份還原、匯入匯出、資料同步與跨次交易管理。若目標引擎的基本操作必須理解這些結構，仍需正確辨識、保留或限制編輯，不能忽略而導致資料遺失。

## 8. 專案參考

- [README.md](USER_GUIDE.md)：目前操作流程、連線、MCP、安全限制、整合測試與封裝。
- [IMPLEMENTATION.md](history/implementation-log.md)：功能邊界及歷次驗證結果。
- [OBJECT_CRUD_AUDIT.md](features/object-crud-audit.md)：四類 SQL 物件基本 12 項操作。
- [OBJECT_CREATION.md](features/object-creation.md)：新增物件表單與引擎差異。
- [OBJECT_EDITING.md](features/object-editing.md)：Index／Trigger 定義編輯與限制。
- [STRUCTURE_EDITING.md](features/structure-editing.md)：Table／View 結構設計。
- [CODE_REVIEW_2026-09-28.md](history/code-review-2026-09-28.md)：必須避免重現的錯庫、錯列、授權、草稿及精度問題。

本文是新增引擎的規格，並非宣稱現有所有引擎已通過其中每個進階邊界測試。具體實作與驗證狀態以對應引擎的交付紀錄為準。
