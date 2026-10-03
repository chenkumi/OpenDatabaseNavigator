# SAP／Sybase ASE 支援計畫與交付紀錄

目標：SAP ASE 16.x（實驗性支援），不包含 SQL Anywhere 或 SAP IQ。使用者目前沒有 ASE 測試環境；本機也未安裝 SAP ASE ODBC 驅動。功能可實作與自動化驗證，但不能宣稱已通過真實 ASE 或發行環境驗收。

## 計畫

1. 新增 `sybase` Engine、連線表單、SAP ASE ODBC driver／TLS 憑證設定與型別列表。
2. 以專案既有 msnodesqlv8 原生 bridge 直接使用 ODBC，避免套用 mssql 的 SQL Server 專用 SQL。每次資料操作使用獨立 session，保持 database 範圍隔離。
3. 實作 ASE catalog metadata、參數查詢、取消／逾時、資料 CRUD 與分頁，接入共用 Command Bus、權限、事件、工作區。
4. 實作四類 SQL 物件新增／定義／修改／刪除及 table 設計器的 ASE 方言；不可安全重建的物件明確標示限制。
5. 加入驅動替身的協定測試、ASE SQL／metadata／DDL 測試、桌面表單測試及可選的真機整合測試。
6. 更新文件、執行既有測試與建置，逐項記錄已驗證／待驗證範圍。

## 依據

- [msnodesqlv8 ASE 範例](https://github.com/TimelordUK/node-sqlserver-v8/blob/master/samples/javascript/sybase-query.js)
- [SAP ASE ODBC 安裝](https://help.sap.com/docs/SUPPORT_CONTENT/sybcon/3362944638.html)
- [SAP ASE ODBC 連線參數](https://infocenter.sybase.com/help/topic/com.sybase.infocenter.dc20116.1500/html/aseodbc/CHDCGBEH.htm)
- [SAP ASE quoted identifiers](https://help.sap.com/docs/SAP_ASE/5b36fd3f1aa440818ee6a7c9900d3e87/aaf3a24abc2b10149f24a4cfe2933e39.html)
- [SAP ASE syscolumns](https://help.sap.com/docs/SAP_ASE/a7b1bd3440ec44929fb80b25110dce17/ab8fe3d0bc2b10148e67dfba6bf1c17d.html?version=16.0.0.0)
- [SAP ASE create trigger](https://help.sap.com/docs/SAP_ASE/4c45f8d627434bb19e10dd0abbb757b0/a680e6f7bc2b1014a28be1c1cd973be4.html?version=16.0.0.0)

## 本輪實作範圍

| 功能       | 實作與界線                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 連線       | `sybase` 引擎；ASE 16.x 版本辨識；預設 port 5000、空 database 使用 master；自訂 ODBC 驅動名稱；TLS 憑證檔；沿用憑證保管、連線狀態及斷線關閉分頁      |
| 資料庫瀏覽 | `sysdatabases`、`sysusers`、`sysobjects`、`syscolumns` 等 ASE 目錄；database／owner／table／view／index／trigger。列出的 database 仍須具備登入權限   |
| 查詢與資料 | ODBC `?` 綁定參數；查詢、篩選、排序、分頁、取消、逾時、結果數量與 8 MiB 回應上限；以主鍵定位資料修改；共用 Query／Data Service                       |
| Table      | 新增／刪除；欄位新增、改名、型別、NULL、DEFAULT、刪除及複合主鍵；型別 autocomplete、長度／精度輸入；identity／computed／timestamp 不提供一般屬性改寫 |
| View       | 新增、讀取定義、`CREATE OR REPLACE VIEW` 修改、刪除                                                                                                  |
| Trigger    | Table 的 AFTER 對應 ASE `FOR`；View 的 `INSTEAD OF`；新增、讀取、`CREATE OR REPLACE` 修改、刪除；不提供 BEFORE                                       |
| Index      | 新增、欄位方向、唯一索引；普通索引讀取／重建／刪除。約束、特殊 status、分割、非預設 segment、自訂空間參數等索引限制 GUI 修改／刪除，交由人工 DDL     |
| 安全與版本 | GUI／MCP 共用既有命令與權限；未知 ASE SQL 保守分類；參數與識別字處理；定義版本檢查；錯誤遮蔽密碼；不讓 renderer 直接存取 ODBC                        |

SQL 物件操作均已接到既有新增、設計、刪除入口，不需另開 ASE 專用工作區。Table 定義頁依 metadata 編輯，並未提供完整的 table DDL 匯出器。

## 驅動與連線

1. 另外安裝合法取得、與程式架構相同的 SAP ASE ODBC 驅動（Windows 桌面為 64 位元）。本專案沒有捆綁 SAP SDK、驅動或授權。
2. 新增連線，選擇「SAP / Sybase ASE（實驗性）」，填入主機、port、database、帳號與密碼。
3. 驅動名稱預設 `Adaptive Server Enterprise`，若 ODBC 管理員註冊的名稱不同，使用實際名稱。請勿填入整段 connection string。
4. 勾選 TLS 時必須指定受信任憑證檔案的本機路徑。未啟用網路讀寫期限時傳遞 `Encryption=ssl` 與 `TrustedFile`，由 SAP ODBC 處理。啟用任一 Read／Write Timeout 時，憑證檔案須為 PEM 格式的 CA 憑證；由 App 建立上游 TLS（至少 TLS 1.2），驗證信任鏈及原始主機名稱／IP，SAP 驅動僅連到本機回送埠。不是跳過憑證驗證或直接將 TLS 主機換成 localhost。實際 ASE／SAP ODBC 相容性仍待真機驗收。
5. 測試連線成功後保存，雙擊連線開啟資料庫清單。測試連線本身不保留 session。

每個 database scope 保留一條連線代表已連線狀態；每次查詢另開一條 session，完成或取消後關閉，避免 `USE`／`SET` 影響下一次操作。使用者不能透過不同查詢延續暫存表、變數或跨次交易；內部多語句 DDL 則共用一條 session。

## JDBC 用戶端編碼（2026-09-30，實驗性）

連線設定的用戶端字元集可選擇預設 **UTF-8 (ODBC)**，或 JDBC 的 UTF-8／Latin-1／Windows-1252／Big5／GBK／GB18030／Shift JIS (MS932)／EUC-JP。選用 JDBC 時填入合法取得的 `jconn4.jar` 絕對路徑並備妥 JDK 11+；Java 路徑可留白自動偵測。查詢不需要 ODBC 或 DDLGen.jar，匯出仍需 DDLGen.jar。既有未設定 charset 的連線保持 ODBC。

所有 JDBC 查詢、目錄、DDL、SQL 檔案及 Heartbeat 共用既有 adapter 與權限服務。每個 session 有獨立 Java worker；腳本／多語句 DDL 沿用同一 session。密碼僅透過 stdin 傳遞，取消／期限／斷線會終止該 worker 並關閉傳輸，不重送語句。TLS 一律經 App 驗證原始主機與 PEM CA，不因停用 I/O 期限而改用明文上游。

設定 jConnect CHARSET 與多位元組 converter，SQL／文字參數會先檢查能否無損表示；不能表示時拒絕執行。獨立查詢前後核對 `@@client_csname`，不允許直接以 SET CHAR_CONVERT 切換設定。SQL 檔案批次間保留 `@@rowcount`／`@@error`，不插入探測 SQL 或呼叫 JDBC setMaxRows；改在腳本結束時檢查編碼，多語句 DDL 於提交前檢查。腳本或其呼叫的程序不可動態切換編碼；結尾檢查失敗不表示先前語句未執行。精確數字用十進位字串、二進位保留 bytes、時間值用 JDBC 文字保留小數秒；區分空值／空字串／空二進位。結果警告、未知 JDBC 型別及超限回報錯誤。這不表示失敗的寫入尚未執行，請先核對資料再重試。

真機測試可在 `.local/sybase.env` 增加 `ASE_CHARSET=big5`（或其他支援值）、`ASE_JCONNECT_PATH`、必要時 `ASE_JAVA_PATH`，再執行 `npm run test:sybase`。省略 ASE_CHARSET 測試既有 ODBC；選用編碼須為伺服器支援的轉換，測試資料也依編碼調整。現有替身測試不能替代 SAP 驅動／伺服器驗收，詳見 [SYBASE_ENCODING_PLAN.md](sybase-encoding.md)。

## 已知限制

### SQL 結構與資料匯出（2026-09-30，實驗性）

資料庫選單的「匯出 SQL 檔案」提供「只有結構」與「結構和資料」。在連線設定填入合法取得的 SAP `DDLGen.jar` 及 `jconn4.jar` 絕對路徑；可指定 `java.exe`／`java`，或留空從 `JAVA_HOME`／`PATH` 偵測。資料匯出另需 JDK 11+，以 source-file mode 執行 App 內附的 JDBC worker。本專案不散布 SAP 工具、JDBC 驅動或授權。

主程序直接啟動 Java 的 `com.sybase.ddlgen.DDLGenerator`，使用 `-TDB -N<database> -XDE -CNUMBER=1 -Jutf8` 產生相依排序的原生資料庫腳本。實際密碼以 `-Pext` 加標準輸入傳入，不放入命令列、環境變數或密碼檔。沿用共用 Command Bus、權限、匯出作業、取消及原生存檔流程；最多 16 MiB／50000 批次。程序非零結束、錯誤紀錄、無效 UTF-8、超限或資料庫名稱不符時不交付 SQL；清除自身暫存目錄及轉送 listener。

**腳本包含原生 CREATE DATABASE、USE、裝置／segment／帳號相依設定**，不是直接套入任意空白資料庫的通用物件腳本。還原前先在 SQL 檔案預覽中檢查名稱與環境，並準備相容伺服器、裝置、登入等必要資源。匯出不會自動執行還原。

資料模式在唯讀交易內對所有本機資料表取得 SHARE 鎖，檢查 `@@error` 確認成功，匯出結束以 ROLLBACK 釋放；這段期間會阻擋其他連線寫入。JDBC 以 BigDecimal、文字／二進位串流讀取資料，不經 JavaScript Number；時間先由伺服器轉成保留六位小數的格式。輸出明確欄位的 INSERT、Unicode escape、二進位 literal、IDENTITY_INSERT 及 identity high-water mark；computed 與 timestamp 由目標端重新產生。每筆 SQL 等待主程序寫入確認，避免堆積無界輸出。

原生結構同時產生完整版本與 `-FRI,TR` 版本，檢查 JDBC／DDLGen 資料表清單一致、過濾結果確實沒有外鍵或 Trigger，且保留批次均未改寫。先建立過濾後結構、載入資料，再重放延後的外鍵、Trigger 及相關權限與設定；資料完成後重新產生完整 DDL，忽略註解比對變更。無法確認順序的原生腳本（例如內嵌外鍵改寫）、加密欄位、proxy／remote table、predicated privileges／access rules、沒有一般儲存欄位的資料表、未知 JDBC 型別、資料警告或超過 16 MiB 均明確拒絕，不交付半成品。需具備讀取所有資料表、metadata、取鎖與 `identity_burn_max` 的權限。

原生工具使用 App 的上游 TCP／TLS 轉送；TLS 一律驗證原始主機與 PEM CA。Read／Write Timeout 套用在上游傳輸，查詢期限另作為工具輸出／進度的閒置期限。這與未啟用期限時由 SAP ODBC 處理 TLS 的查詢路徑不同。

`tests/sybase-export.test.ts` 在本機 JDK 可用時編譯自行撰寫的 DDLGen 與 JDBC 測試替身，驗證真正程序邊界、Unicode、標準輸入密碼、失敗／取消／逾時、上游讀取期限、範圍檢查、暫存清理、資料精度序列化、取鎖／截斷／結構變更失敗及兩種模式的 Command Bus 儲存／匯入預覽。缺少 JDK 時明確跳過程序測試。**此替身不是 SAP 工具，不證明真實 ASE 物件完整性或資料還原相容性**；目前沒有 SAP 工具與 ASE 測試環境。

真機測試可另設定 `ASE_JAVA_PATH`（選用）、`ASE_DDLGEN_PATH`、`ASE_JCONNECT_PATH`；`npm run test:sybase` 將於刪除測試物件前匯出結構，檢查四類物件均出現在原生腳本。另設 `ASE_EXPORT_DATA=1` 才執行資料模式，會對整個指定測試資料庫取鎖。完整原生輸出、精確值往返、不同 SP／PL 的 DDL 排序與跨伺服器還原仍須在具備環境時驗收。

依據：[SAP ddlgen 參數與相依順序](https://help.sap.com/docs/SAP_ASE/da6c1d172bef4597a78dc5e81a9bb947/a7ed349ebc2b1014b50fbd20d6921128.html)、[SAP 隱藏 ddlgen 密碼](https://help.sap.com/docs/SAP_ASE/da6c1d172bef4597a78dc5e81a9bb947/a7ee26cabc2b10148a7a94b9078ae479.html)、[Java main class 官方說明](https://help.sap.com/doc/a61873ebbc2b10148a2dd8b5b0a886fc/16.0.4.4/en-US/SAP_ASE_Utility_Guide_en.pdf)。

資料模式依據：[LOCK TABLE 與逾時](https://help.sap.com/docs/SAP_ASE/e0d4539d39c34f52ae9ef822c2060077/ab3872e6bc2b1014ad06b1e3b545ba15.html)、[CONVERT style 140](https://help.sap.com/docs/SAP_ASE/2df920cd5b1644e5a065d55b637d5e92/aacb76eabc2b1014a15ce085fd168d48.html?version=16.0.3.15)、[Unicode escapes](https://help.sap.com/docs/SAP_ASE/41214a0aacb244b4983d171786f06412/aabdbd84bc2b1014994df955ef045149.html)。

### 其他限制

- **尚未通過真實 ASE 驗收**：本機沒有 ASE ODBC 驅動與伺服器。ASE 16.x 是目標版本；特定 SP／PL、作業系統及驅動版本相容性待測，不適用於 SQL Anywhere／IQ。
- 多語句 DDL 使用 `BEGIN TRANSACTION`／`COMMIT`，失敗嘗試 rollback，需要目標資料庫允許 `ddl in tran`。本程式不自動改資料庫選項，預覽也不宣稱 ASE DDL 保證原子性；伺服器對特定 DDL 的交易限制仍可能拒絕操作。
- 一般索引重建只開放可辨識的基本形式；原始 CREATE INDEX 的暫時性 fillfactor 未必保存在 catalog，因此不聲稱完整重現原始 SQL。自訂索引必須自行審查 DDL。規則、加密或特殊欄位屬性會阻止一般結構修改。
- `DECIMAL`／`MONEY`／`SMALLMONEY`／`SQL_VARIANT` 結果目前拒絕解碼，避免 native bridge 的浮點精度損失；可在 SQL 中轉成足夠長度的 VARCHAR。`NUMERIC`／`BIGINT` 必須以字串回傳，否則報錯。含上述受限欄位的 `SELECT *`／資料頁可能無法直接開啟。
- 若已執行寫入語句後才遇到結果型別錯誤，寫入可能已發生，錯誤訊息會提醒勿直接重送。
- 一次僅處理一個結果集；不支援 EXPLAIN、GUI 的全預設值空欄位 insert、跨次查詢交易、完整 stored procedure／event／rule 管理。
- 分頁使用有界串流跳過前 N 筆，不產生不相容的 LIMIT／OFFSET SQL；大 offset 會增加查詢成本。穩定分頁需明確 ORDER BY，重查期間資料變動仍可能影響結果。
- 目錄最多讀取 5000 列，超過會明確拒絕而非假裝完整；目錄權限或 definition 不完整時限制操作。
- 取消與逾時等待 native `free` 事件釋放 statement。實際 SAP 驅動的取消、失聯、TLS、Unicode／LOB／日期精度及 affectedRows 行為仍須真機測試。macOS／Linux 與安裝包尚未驗證。

## 驗證方式

2026-09-28：建置與型別檢查通過；完整測試 **79 passed／25 skipped**，其中 ASE 有 12 項自動化測試。ASE 桌面表單／缺少驅動 smoke、既有 Index／Trigger 及資料表設計器桌面回歸通過。真實 ASE 整合測試因沒有環境而跳過，沒有計入成功數。最後一輪與建置並行時曾發生 Vitest 的 MCP worker 異常退出；建置結束後，MCP 單獨 6 項與 `npm test -- --maxWorkers=2` 全套均通過。

不需要 ASE 伺服器：

```sh
npm run typecheck
npm test
npm run test:desktop:sybase
```

`tests/sybase.test.ts` 使用事件式 native driver 替身，檢查 session 隔離／釋放、分頁、取消／逾時、DDL rollback、精度保護、catalog 解析、各類 SQL 計畫、權限與工作區流程。替身驗證程式邏輯，不代表伺服器接受全部 SQL。

`scripts/smoke-sybase.mjs` 啟動真正 Electron，驗證表單、預設 port、TLS 必填、缺少驅動、儲存／編輯及不保存明文密碼。使用刻意不存在的驅動名稱，不會連接任意資料庫。

有 ASE 測試環境後，在忽略版控的 `.local/sybase.env` 設定：

```dotenv
ASE_HOST=your-test-server
ASE_PORT=5000
ASE_DATABASE=your_disposable_test_database
ASE_USERNAME=your_test_user
ASE_PASSWORD=replace_locally
ASE_SCHEMA=dbo
ASE_DRIVER=Adaptive Server Enterprise
ASE_TLS=1
ASE_TRUSTED_FILE=C:\certs\ase-root.pem
ASE_READ_TIMEOUT=1000
ASE_WRITE_TIMEOUT=2000
```

帳號需要 catalog 讀取、表格 DML 與四類物件 DDL 權限，測試 database 須允許 `ddl in tran`，並支援方括號識別字。請使用專用測試 database，勿以正式庫驗證。之後執行：

```sh
npm run test:sybase
```

此指令缺少設定時直接停止，不會退回 localhost；測試使用隨機 `dw_ase_*` 名稱並在 finally 清除自身建立的物件。普通 `npm test` 會跳過這項真機測試，不會偽裝通過。

`ASE_READ_TIMEOUT`／`ASE_WRITE_TIMEOUT` 單位為毫秒，省略或 0 表示停用。開啟時同一組 CRUD／DDL 測試會經過 App 傳輸層；Read Timeout 在 1～5000 時，另驗證 WAITFOR 讀取逾時及後續查詢恢復。請先以停用期限模式驗證驅動基本相容性，再測試啟用期限及 TLS 的組合。

`tests/sybase-io.test.ts` 使用真正 TCP／TLS socket 搭配模擬 native driver，涵蓋分塊進度、閒置 heartbeat、並行 session 隔離、上游寫入停滯、失敗不重送、同一 SQL 檔案失敗後不另開 session、取消／逾時登入及遲到 callback 清理。憑證名稱不符或不受信任時，上游不收到登入資料。這些測試不使用 ASE TDS 協定，不能取代 SAP ODBC 真機驗收。

啟用期限的 session 設定 `HASession=0;RetryCount=0`，避免驅動自行轉送到未監測的節點。依 [SAP ODBC 連線參數](https://help.sap.com/docs/SAP_ASE_SDK/b3c09d30f5d148fb8339f43f9f029ff0/b1dd3876bbf910149ce1e9ba11d2d013.html)，`Encryption` 僅列出 `ssl`，預設為空；App 處理 TLS 時省略此參數，不使用 ADO.NET 的 `none` 值。TLS 傳輸設計依據 [SAP 的憑證驗證流程](https://help.sap.com/docs/SAP_ASE_SDK/b3c09d30f5d148fb8339f43f9f029ff0/b1efeaf5bbf910148f7bb00216fc4e37.html)：在 TCP 連線後、傳送使用者資料前進行 TLS 握手。

真機測試涵蓋 metadata、參數 CRUD、Unicode、分頁、NUMERIC 精度、Table 型別修改、View／Trigger／Index 修改及四類物件刪除。仍需後續補驗不同 server／driver 版本、複合 PK／預設值／改名、TLS 拒絕不可信憑證、長查詢中斷、網路斷線、非 dbo owner、特殊索引及安裝包。

## 原始碼位置

可選用戶端編碼已接上獨立 JDBC session，保留 ODBC UTF-8。實作與待完成的 SAP 真機驗收條件見 [SYBASE_ENCODING_PLAN.md](sybase-encoding.md)。

ODBC 編碼設定已修正為 `CharSet=ClientDefault;CodePageType=Other`，另以 `ClientCharset` 指定 UTF-8（Windows 為 code page 65001，其他平台為 utf8）。SAP ODBC 的 `CharSet` 是 ServerDefault／ClientDefault／NoConversions 轉換模式，與 ADO.NET 的同名參數不同；原生橋接的文字解碼使用 UTF-8，因此不能直接允許任意 ClientCharset 而不轉換回 JavaScript 文字。本項有參數回歸測試，仍需上述真機 Unicode 測試驗證實際驅動。參考：[SAP ODBC Character Sets](https://help.sap.com/docs/SAP_ASE_SDK/b3c09d30f5d148fb8339f43f9f029ff0/b1d67932bbf91014bc5697dcd90b95d4.html?version=16.0.4.4)、[Connection Parameters](https://help.sap.com/docs/SAP_ASE_SDK/b3c09d30f5d148fb8339f43f9f029ff0/b1dd3876bbf910149ce1e9ba11d2d013.html)。

- Adapter／目錄：`src/main/database/adapters/sybase/`
- 方言與服務：`sql-builder.ts`、`create-database.ts`、`table-structure-service.ts`、`create-object-service.ts`、`database-object-service.ts`、`drop-object-service.ts`
- 介面：`ConnectionForm.tsx`、`CreateObjectView.tsx`、`TableDesigner.tsx`、`column-types.ts`
- 驗證：`tests/sybase*.test.ts`、`scripts/test-sybase.mjs`、`scripts/smoke-sybase.mjs`

補充依據：[ASE 索引空間參數](https://help.sap.com/docs/SAP_ASE/ff2a4810a3f54c1aa6af0e904aa2e3d8/ab0afec0bc2b1014a6d3bd57b67d1fe6.html)、[ASE sysindexes](https://infocenter.sybase.com/help/topic/com.sybase.dc36274_1251/html/tables/X22611.htm)、[ASE sp_rename](https://help.sap.com/docs/SAP_ASE/fbeb8a16c28d4140a01bd3b5821e0cd5/ab7a0ecfbc2b1014adff81652c68d4d3.html?version=16.0.2.1)。
