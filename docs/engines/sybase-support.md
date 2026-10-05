# SAP／Sybase ASE 唯讀支援

## 目前範圍

**Sybase 引擎在本版本一律唯讀**，不受人類／Agent 身分、連線的 Agent write 設定、核准或全域政策影響。

- ASE **11.x** 是目前實測目標；已在 Windows 64 位元 SAP ODBC／ASE **11.5.1.2** 驗證基本連線與唯讀查詢。
- ASE **16.x** 保留實驗性唯讀接入，沒有本輪真機驗收證據。
- ASE 12.x／15.x、SQL Anywhere、SAP IQ 不在目前接入範圍。不提供手動版本下拉選單；登入後以 `SELECT @@version` 自動辨識。
- 成功登入不表示所有版本、資料型別、編碼或 catalog 功能均相容。

| 操作 | 狀態 |
| --- | --- |
| SELECT、篩選／排序／分頁、取消、Heartbeat | 唯讀可用；僅接受受限制的 SELECT 語法及內建函式白名單 |
| Database／owner／table／view 清單、基本欄位資訊 | 可用；ASE 11.x 使用舊版 catalog 路徑 |
| Index／Trigger 清單 | 可讀；ASE 11.x 索引詳細定義尚未驗證，明確拒絕 |
| 結構檢視 | 唯讀；不提供完整約束／進階屬性／產生欄位能力承諾 |
| INSERT／UPDATE／DELETE、SELECT INTO、EXEC／程序、DDL、資料庫設定修改 | 全面停用 |
| SQL 檔案執行、原生 SQL 結構／資料匯出 | 停用；避免 script 或 Java／DDLGen 路徑绕過唯讀限制及匯出取鎖 |
| 已取得結果的 CSV／JSON 匯出、複製 | 保留，不寫入 ASE |

GUI 和 MCP 都先經共用 Command Bus／PermissionService 的引擎限制；adapter 再檢查 SELECT 並拒絕 DDL、script、原生匯出。唯讀旗標本身不作為 SQL 安全證據。請另使用伺服器端唯讀帳號，作為額外防護；本程式不修改帳號或伺服器設定。

## 導覽分層

Sybase 使用「連線 → 資料庫 → Owner（例如 dbo）→ Table／View／Index／Trigger」的層級。ASE 11.x 的 Owner 是物件擁有者，不是 MySQL 與資料庫同義的 Schema；MySQL 等其他引擎維持既有導覽方式。

Owner 清單只列出實際擁有可瀏覽 Table／View 或已掛接 Trigger 的使用者，不再直接列出所有 `sysusers` 條目。Index 依所屬使用者資料表的 Owner 分組；只有 View 或 Trigger 的 Owner 亦保留。沒有物件、只有程序／系統表或未掛接 Trigger 的使用者不顯示，空資料庫可沒有 Owner 節點。此規則與既有物件清單一致，不代表額外的物件存取權限判斷；也不保證與 DBeaver 的個別篩選設定相同。外部物件變更後請重新整理瀏覽器。

Owner 下的表名不重複顯示 `dbo.` 前綴，但開啟、搜尋、複製完整名稱與工作區範圍仍保留 owner 身分；同名表或索引不會混到另一個 owner。展開 owner 才載入其 table／view 清單，搜尋時自動展開 owner；Index／Trigger 清單亦按 owner 過濾。此修改不新增程序分類或解除唯讀限制。

`npm run test:desktop:sybase-tree` 使用隔離 Electron renderer、實際元件與 IPC catalog 替身驗證分層、同名物件、範圍切換、搜尋、重新整理／失敗復原及中英文／明暗／720p／1080p 布局；不需要憑證，不連接真實 ASE。

## 連線設定

1. 安裝與應用程式架構一致、合法取得的 SAP ASE ODBC driver；本專案不散布 SAP SDK／授權。
2. 選擇「SAP / Sybase ASE（唯讀、實驗性）」並填入主機、port、database、帳號與密碼。預設 port 5000、空 database 使用 master。
3. 驅動預設 `Adaptive Server Enterprise`，只填註冊名稱，不填完整 connection string。
4. ODBC 使用 `CharSet=ServerDefault;Language=us_english`。已確認本輪 ASE 11.5 驅動在普通 SERVER／UID／PWD 值外加大括號會連線失敗，因此普通值不加括號；特殊值仍使用 ODBC escaping，不直接插入未驗證的分號／括號／控制字元。
5. ASE 11.x 不支援方括號識別字及 ANSI JOIN。基本 catalog 使用逗號連接；生成 SELECT 的方括號僅轉換成已驗證的簡單 ASCII 識別字。保留字或複雜識別字可能被拒絕，不會猜測改寫。
6. TLS 需提供受信任憑證檔。開啟 Read／Write Timeout 時，使用 PEM CA，由 App 驗證原始主機及信任鏈；未開啟期限時 ODBC 使用 `Encryption=ssl;TrustedFile`。真機 TLS／期限相容性仍未驗收。
7. JDBC 編碼選項需 JDK 11+ 與合法取得的 `jconn4.jar`；仍受同一唯讀限制。本輪未驗證真實 SAP JDBC。

## 唯讀真機測試

在忽略版控的 `.local/sybase.env` 設定，密碼勿貼到終端／文件或提交 Git：

```dotenv
ASE_HOST=your-server
ASE_PORT=2000
ASE_DRIVER=Adaptive Server Enterprise
ASE_DATABASE=your_database
ASE_USERNAME=your_readonly_user
ASE_PASSWORD="replace_locally"
ASE_SCHEMA=dbo
ASE_TLS=0
ASE_READ_TIMEOUT=0
ASE_WRITE_TIMEOUT=0
```

伺服器要求 TLS 時改為 `ASE_TLS=1` 並設定 `ASE_TRUSTED_FILE`。程式不會自動停用 TLS。

```sh
npm run test:sybase
```

**此命令現在只執行 `tests/sybase-readonly-integration.test.ts`**，不再執行舊 CRUD／DDL 整合流程。缺少設定會停止，不回退 localhost。檢查版本、常數、中文常數、參數、catalog 數量／清單、系統表欄位與 heartbeat；不讀取业务資料列，不建立暫存表、不匯出取鎖、不修改伺服器設定。普通 `npm test` 預設跳過真機測試。

禁止寫入的測試使用替身與 spy，確認 driver／命令 execute 沒有被呼叫；不在真機嘗試破壞性 SQL。

## 分頁停止與清理

Native ODBC 滿頁時先暫停列派送，再於下一個事件迴圈執行取消，避免在 row/batch 回呼內同步釋放 statement。正常等待 `free`；一秒內沒有完成時，關閉該次獨立 session 的 I/O，並等待 native `close` 回呼確認成功，才回傳已收集的滿頁資料。關閉失敗或一秒內不回呼則明確拒絕，不因已送出 cancel 或關閉 socket 就假裝成功；原有取消、逾時、網路與精度錯誤保留。

未加密的 native session 即使 Read／Write Timeout 為零，也使用 App 自有的 loopback relay，提供可實際終止的 I/O 邊界；停用 driver failover／重播，不新增讀写期限。TLS 沒有設定期限時維持原生 ODBC 憑證路徑。直接原生 TLS 若 close 不回呼，界限只保證呼叫者不永久等待，不能保證 native handle 已釋放；真實 TLS／SAP JDBC／ASE16 的終止相容性仍未驗收。

斷線會阻擋新查詢、取消並等待既有查詢的有界清理，也包含已脫離 anchor 的背景 close。失效的 idle anchor 會關閉，下次明確操作才建立新連線，不重播原查詢。

`node scripts/diagnose-sybase-bisale-desktop.mjs` 是指定環境的真實 Electron 驗收（需先 `npm run build`），固定使用 `BIdb.dbo.BI_Sale`、2 列頁面，**會實際讀取業務資料**；不可當成不讀業務列的一般 smoke。只保存列／欄／事件與 close 成功計數，不輸出欄位內容、不保存截圖／trace／video、不寫入 ASE。已確認初始頁、下一頁、刷新、上一頁以及正常斷線／關閉。頁面大小包含 collector lookahead／flush，不能視為 native driver 的精確讀取列數；沒有 ORDER BY 的 offset 翻頁仍不保證穩定次序。

## 高精度資料瀏覽

GUI 表格分頁與 MCP `data.select` 共用讀取路徑。Sybase 先讀取系統欄位 metadata，將 DECIMAL／NUMERIC／MONEY／SMALLMONEY 的查詢結果轉為 `VARCHAR(80)`，保留原欄名與 NULL，避免 native driver 的 JavaScript number 精度損失。依底層型別判斷，亦適用使用者自訂 alias 型別；不改動資料表或儲存的資料。

MONEY／SMALLMONEY 先轉 `NUMERIC(38,4)` 再轉文字，保留四位小數；ASE 11.5 不能只依賴文字轉換 style 2。排序使用原 precision／scale 的數值表達式，避免同名結果 alias 導致字串排序。數值過濾保留來源欄位，文字參數明確轉成 numeric，依輸入本身小數位處理而非捨入到欄位 scale；精確數值字串目前接受一般十進位格式（不接受科學記號），最多 38 位。LIKE 明確比對數值的文字表示。選取／排序欄位需使用 catalog 的精確名稱。

此自動轉換僅用於結構化資料瀏覽，不猜測改寫 SQL 分頁的任意 SELECT。手寫 SQL 的原始 DECIMAL／MONEY 等仍受精度防護；可明確使用 `CONVERT(varchar(80), column)`，MONEY 使用 `CONVERT(varchar(80), CONVERT(numeric(38,4), column))`。限定／引號自訂函式與有副作用 SQL 仍拒絕；帶長度／精度的型別語法只在 CONVERT 第一個參數允許。

`sysobjects.type` 的 CHAR 尾端空白已正規化，View 不再誤分類為 Table。

專用驗證 `tests/sybase-read-projection-integration.test.ts` 以 `ASE_READ_PROJECTION_INTEGRATION=1` 手動啟用，使用已確認的 `kyclaim.dbo.clmssrcp`；僅查系統目錄、固定數值常數及 WHERE 1=0，**不讀業務資料列、不寫入**。普通測試預設跳過，`npm run test:sybase` 仍只執行一般唯讀 integration。測試需要該目標存在，不用於任意伺服器。

## 已知限制與驗證界線

- 真機證據包含 ASE 11.5.1.2 的基本唯讀功能、中文常數往返、指定表零列投影與 metadata、38 位數值／MONEY 常數、View 分類及 BI_Sale 有列的桌面滿頁讀取／翻頁／刷新／斷線；不能代表所有 11.x／16.x、所有業務資料編碼或 LOB／時間精度。
- 僅支援 SELECT；未知函式、限定／引號函式、SQL batches、CASE／END、REPLACE 與有副作用語法會保守拒絕。複雜查詢可能需後續逐項驗證後擴充。
- 任意 SQL 的 ODBC DECIMAL／MONEY／SMALLMONEY／SQL_VARIANT 原始結果仍拒絕可能有損的解碼；表格瀏覽使用上述無損文字投影。SQL_VARIANT 不提供自動投影轉換，NUMERIC／BIGINT 原始結果仍要求字串。
- 每次查詢使用独立 session；不支援跨次交易／暫存表／變數。
- 目錄最多 5000 列、結果有既定上限；分頁跳過前 N 列，需 ORDER BY 才有穩定順序。
- 取消、網路斷線、TLS、不同 driver 版本與安裝包仍需真機驗收。先前的 CRUD／DDL／原生匯出實作與替身測試不代表本版本開放這些操作。

## 原始碼

- 共用引擎限制：`src/shared/engine-capabilities.ts`
- SQL 唯讀驗證：`src/main/security/ase-readonly.ts`
- Adapter／legacy SQL／catalog：`src/main/database/adapters/sybase/`
- 權限與命令：`src/main/mcp/permissions/permission-service.ts`、`src/main/application/commands/command-bus.ts`
- 自動化防護：`tests/sybase-readonly.test.ts`
- 真機唯讀：`tests/sybase-readonly-integration.test.ts`、`scripts/test-sybase.mjs`
