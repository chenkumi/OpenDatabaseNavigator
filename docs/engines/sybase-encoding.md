# ASE 用戶端編碼：驅動限制與後續實作

> 目前狀態：Sybase 已改為全面唯讀；ODBC 使用 `CharSet=ServerDefault;Language=us_english`，不再套用下文的 ClientDefault／ClientCharset 設定。ASE 11.5.1.2 已通過基本連線與中文常數往返，但尚未驗證既有 VARCHAR／TEXT 業務資料的編碼。下文保留先前設計與驅動限制，不代表目前開放寫入、SQL 檔案執行或原生匯出。現行功能與測試入口以 [ASE 唯讀支援](sybase-support.md) 為準。

更新日期：2026-09-30。JDBC 傳輸與設定介面已實作，Java 替身／TCP／TLS／桌面測試已通過；SAP 驅動與真實 ASE 驗收仍未完成。

## 已確認的限制

預設 ODBC 查詢使用 `msnodesqlv8@5.5.0` 與 SAP ASE ODBC。已核對實際安裝套件的 C++ 原始碼，而非只依據套件名稱推測：

- `cpp/src/odbc/odbc_statement.cpp` 的 `bounded_string_char`／`lob_char` 以 `SQL_C_CHAR` 取得 VARCHAR／TEXT 位元組。
- `cpp/src/js/js_object_mapper.cpp` 的 `handleStringTypes` 將窄字元資料交給 `Napi::String::New`，按 UTF-8 轉成 JavaScript 字串。一般查詢沒有回傳這些原始文字位元組的公開設定。
- SQL 本文使用 wide ODBC API，Unicode 結果也有 wide 路徑，但這不會使 VARCHAR 結果改用 wide 路徑。只檢查 SQL 本文或 Unicode 型別會漏掉問題。

SAP ODBC 的 `CharSet` 是轉換模式，`ClientCharset` 才是應用程式使用的編碼。因此直接將目前的 `ClientCharset=65001` 改成 Big5 code page，可能在 JavaScript 收到值之前就已錯誤解碼；不能再靠 renderer 或 `iconv-lite` 還原。

ODBC 路徑維持 UTF-8。表單與共享 schema 現在可接受下列八種 JDBC charset，且必須設定 jconn4.jar；一般 JDBC 查詢依所選編碼，SQL 匯出獨立使用 UTF-8。

## 已實作的傳輸路徑

已利用既有 Java／jConnect 工具設定建立可選的 JDBC 查詢傳輸層，保留目前 ODBC 連線的行為。JDBC 路徑仍由主程序 adapter 管理，沿用 Command Bus、權限、session、取消、Heartbeat 與網路期限；renderer 不載入驅動、不直接連線。

1. `jdbc-session.ts`／`AseQuerySession.java`：每個實體連線一個 worker，持續管理 query、參數、目錄、DDL、SQL 檔案與 Heartbeat。使用 16 MiB 上限的長度前綴訊息，UTF-8/base64 文字、十進位精確數值、二進位與 NULL 各自表示；結果欄位有 8 MiB 上限，逐列 ACK 限制輸出堆積。
2. jConnect 明確設定 `CHARSET`、`PureConverter`、停用 Unicode fallback 與 HA／failover。八種值為 `utf8`、`iso_1`、`cp1252`、`big5`、`cp936`、`gb18030`、`sjis`、`eucjis`；`sjis` 對應 MS932。SQL／文字參數在送出前用同一 Java charset 嚴格往返檢查。
3. 啟用 CHAR_CONVERT 的錯誤回報、STRING_RTRUNCATION，設定足夠 TEXTSIZE，登入與獨立查詢前後核對 `@@client_csname`。SQL 檔案與多語句 DDL 使用保留狀態的執行模式，批次之間不送探測 SQL、不呼叫可能產生 SET ROWCOUNT 的 setMaxRows；分別在腳本結尾或提交前檢查編碼，避免改寫 `@@rowcount`／`@@error`。禁止腳本動態切換編碼，結尾檢查不會回滾先前已提交的寫入。結果或 driver 警告不交付成功；查詢筆數以 JDBC setMaxRows 限制，仍等候完整狀態檢查，不因取得足夠列就略過結尾警告。未知型別拒絕解碼，不猜測值。
4. 每個 worker 自有 TCP／TLS relay；TLS 驗證原始主機及 PEM CA，與讀寫期限是否啟用無關。登入／查詢取消及逾時終止程序、關閉 socket、回收自己建立的暫存目錄。密碼透過 stdin，不出現在 argv／環境或文件；錯誤回報遮蔽密碼。
5. 表單提供 ODBC UTF-8 及八個 JDBC 選項，缺少 jconn4.jar 拒絕保存 JDBC 選項；實際缺少 Java／JAR 時連線回報錯誤，不退回其他驅動。修改編碼依原流程關閉舊連線，須重新連線。SQL 匯出固定 UTF-8，需用 UTF-8 連線還原。

擴充 native bridge，提供可選的 wide 結果或原始位元組介面，也是可能方案，但需要自行建置、封裝與維護各平台原生模組；不能只修改 node_modules 後把本機結果當成可交付版本。

## 驗收條件與尚缺證據

- 已驗證的離線 worker 測試：多個同 session 語句、精確值、空值、巨大欄位限制、有長度上限的程序訊息、連線隔離、取消／逾時／程序終止與憑證遮蔽。
- 待驗證的 SAP 真機：所選 charset 與伺服器協商值、中文字面值／參數／識別字／錯誤、VARCHAR／UNIVARCHAR／TEXT／UNITEXT、不可表示字元、NULL／空值，以及 CRUD、DDL、SQL 檔案與匯出還原。
- 桌面已驗證編碼與工具路徑保存／重新開啟、缺少工具的錯誤與中文表單；SAP 真實連線、Heartbeat 斷線與各物件操作仍需真機驗收。

目前沒有 SAP ASE 伺服器、SAP ODBC、jConnect／DDLGen 可供真實驗收。自行撰寫的 Java driver 替身只能驗證程序契約，不能證明 SAP 編碼轉換及還原相容性；功能對照表第 06 項仍保留部分實作。

## 來源

- [SAP ODBC Character Sets](https://help.sap.com/docs/SAP_ASE_SDK/b3c09d30f5d148fb8339f43f9f029ff0/b1d67932bbf91014bc5697dcd90b95d4.html?version=16.0.4.4)
- [SAP jConnect Character Set Converters](https://help.sap.com/docs/SAP_ASE_SDK/c4016b5564ed4c98bbade36a3a35202d/b0a3a134bbf9101495b9b24b45cbd995.html?version=16.0.4.4)
- [SAP jConnect 支援的字元集與 JDK 對應](https://help.sap.com/docs/SAP_ASE_SDK/c4016b5564ed4c98bbade36a3a35202d/b0a415cebbf91014b256c7cd4e2bff16.html?locale=en-US&state=PRODUCTION&version=16.1.0.2)（實際 16.x 工具版本仍需驗證）
- [msnodesqlv8 原始碼專案](https://github.com/TimelordUK/node-sqlserver-v8)；本次程式碼核對以 package-lock.json 對應的本機 5.5.0 套件為準。

伺服器編碼核對依據：[ASE 字元集全域變數](https://help.sap.com/docs/SAP_ASE/d7e44537cb064acf9bf9e0db931696d2/a79cce9ebc2b1014aaedfdcd4feaaa1f.html?locale=en-US&state=PRODUCTION&version=16.0.1.0)。

批次狀態依據：[SAP @@error 檢查規則](https://help.sap.com/docs/SAP_ASE/b65d6a040c4a4709afd93068071b2a76/aa7dd4f2bc2b10149720f6d9f2a6d343.html?locale=en-US)、[ASE 全域變數](https://help.sap.com/docs/SAP_ASE/2df920cd5b1644e5a065d55b637d5e92/aaed9e75bc2b1014bcb5dc46d648f881.html)。
