# 預定功能與目前實作對照表

盤點日期：2026-09-30。需求來源：[FUNCTIONS.txt](requirements.txt)。

本表依目前 renderer、共用型別／命令 schema、Application Service、資料庫 adapter 與測試程式交叉盤點。已更新連線／資料庫屬性（12～13）、外鍵／CHECK 設計器、產生欄位（23）、欄位／資料表選項（25、27～29、50～53）、索引選項（32～34），以及檢視進階選項（56～59）；尚未完成的項目保留缺口，不以通用 SQL 可執行代替專用功能。

## 判定方式與統計

- **已實作**：已有可操作入口及對應處理路徑，能完成該項基本功能；引擎差異或特殊物件限制另列。
- **部分實作**：只有辨識／保留、固定後端設定、部分選項，或只能在該物件的 SQL 定義編輯器操作，尚未提供完整屬性表單。
- **未實作**：沒有對應專用功能。通用 SQL 查詢可以手動送出某種 DDL，不等於已實作該功能的管理介面。
- 統計依原清單的 **62 個最末層項目**，不重複計算「內容」「進階」「功能」等分類節點。這是項目數，不是開發工時或跨引擎驗收完成率。

| 分類 | 項目數 | 已實作 | 部分實作 | 未實作 |
|---|---:|---:|---:|---:|
| 連線 Connection | 10 | 7 | 3 | 0 |
| 資料庫 Database | 6 | 4 | 2 | 0 |
| 資料表 Table | 37 | 37 | 0 | 0 |
| 檢視 View | 6 | 6 | 0 | 0 |
| 查詢 | 3 | 3 | 0 | 0 |
| **合計** | **62** | **57** | **5** | **0** |

共有 **5 項尚未完整實作**，均為部分實作。完整補齊目標持續進行；SQL 檔案執行（14）及 SQLite／MySQL／MariaDB／PostgreSQL／SQL Server 匯出（15～16）已有實作，ASE 已接上原生 ddlgen 結構與 JDBC 資料匯出，具取鎖、精確值、延後外鍵／Trigger、取消及結構變更檢查；仍待 SAP 工具與真實伺服器驗收。獨立 Read／Write Timeout 已提供 MySQL／MariaDB、PostgreSQL 查詢／原生匯出、Redis 命令及 SQL Server 帳密查詢路徑；SQL Server 帳密 TCP 原生匯出亦已接上；Windows TCP 驗證已加入 SPN 與 ODBC／原生匯出期限，尚待 Windows TCP 身分端到端驗證；ASE 讀寫期限已接入獨立 session 傳輸，通過 TCP／TLS 模擬驅動測試，待真實 SAP ODBC 驗收。

引擎範圍：SQLite、PostgreSQL、MySQL／MariaDB、SQL Server；SAP／Sybase ASE 有實作但仍為實驗性支援，沒有真實 ASE 伺服器驗證。Redis 不適用 Table／View／Index／Trigger 等 SQL 物件功能。下表的「已實作」不代表每個引擎都有同名或完全相同的能力。

## 1. 連線 Connection

| 編號 | 原清單功能 | 狀態 | 現況／缺口 | 依據 |
|---|---|---|---|---|
| 01 | 連線名稱 | 已實作 | 可新增、儲存與修改連線名稱。 | [C1](#c1-連線表單與模型) |
| 02 | 主機 | 已實作 | 網路型資料庫提供 Host；SQLite 改用檔案路徑。 | [C1](#c1-連線表單與模型) |
| 03 | 通訊埠 | 已實作 | 可設定數字 port，切換引擎帶入預設值；SQLite 不適用。 | [C1](#c1-連線表單與模型) |
| 04 | 使用者名稱 | 已實作 | 網路連線可填帳號；SQL Server Windows 驗證使用目前 Windows 身分。 | [C1](#c1-連線表單與模型) |
| 05 | 密碼 | 已實作 | 密碼輸入、加密儲存及編輯時保留既有密碼；不保存在公開 Connection 型別中。 | [C1](#c1-連線表單與模型) |
| 06 | 進階 → 用戶端字元 | 部分實作 | MySQL／MariaDB 可輸入 charset 並套用到 mysql2 握手。Redis 可選 UTF-8、Latin-1、Windows-1252、Big5、GBK、GB18030、Shift JIS、EUC-JP，實際編解碼文字鍵／值；JSON 文件固定 UTF-8，拒絕有損轉換，既有資料不轉碼。PostgreSQL 可選 UTF8、LATIN1、WIN1252、BIG5、GBK、GB18030、SJIS、EUC_JP，協定文字／SQL／參數／結果無損轉碼，二進位參數不改寫；真實伺服器與 TLS 驗證已通過。修改需重連後生效；SQL Server 沒有連線級 client charset，ASE 保留 ODBC UTF-8，另提供八種 JDBC 編碼，需 JDK 11+／SAP jconn4.jar；已接上完整 session、精確值、取消／期限與編碼核對，Java 替身及 TCP／TLS、桌面設定通過，SAP 真機仍待驗收。 | [C1](#c1-連線表單與模型)、[C2](#c2-連線與查詢逾時) |
| 07 | 進階 → Heartbeat Interval | 已實作 | 使用者已確認原 TTL 為誤植。網路引擎可設定保持連線間隔（秒），0 停用；連線成功後排程、不重疊，主動中斷／關閉程式停止檢查。失敗轉為未連線並禁止隱式重連；ASE 探測既有 anchor、Redis 使用 PING。SQLite 不適用；ASE 僅模擬驅動驗證。 | [C1](#c1-連線表單與模型)、[C2](#c2-連線與查詢逾時) |
| 08 | 進階 → Connection Timeout | 已實作 | 網路引擎表單可設定 100～300000 毫秒，預設 10000；保存後交由 MySQL、PostgreSQL、SQL Server、Redis、ASE 驅動使用。ASE 原生登入逾時取整至秒，另有毫秒計時；查詢另沿用自身期限。SQLite 不適用。 | [C2](#c2-連線與查詢逾時) |
| 09 | 進階 → Read Timeout | 部分實作 | MySQL／MariaDB 可設定 socket 讀取無進度期限（毫秒，0 停用），收到資料重設，閒置／本機暫停消費不計時；涵蓋查詢、DDL、SQL 檔案及匯出，TLS 亦適用。PostgreSQL 亦支援查詢／DDL／SQL 檔案，原生 pg_dump 匯出亦套用 socket 期限；原生工作含登入、處理本機輸出時暫停讀取計時。SQL Server 帳密查詢／DDL／SQL 檔案及 TCP 原生匯出也適用；原生匯出共用工作讀取進度、逐 socket 寫入期限，需新版 SqlServer PowerShell 模組。暫停消費結果時不計時。與查詢總期限獨立；Redis TCP／TLS 全命令與 Heartbeat 亦適用；Windows TCP 驗證已加入逐 ODBC 連線與原生匯出期限，需明確 SPN；真實 ODBC 傳輸已驗證，Windows TCP 身分端到端尚待環境。ASE 已接上逐 session TCP／TLS 期限，閒置暫停、失敗不重送；TLS 由 App 驗證原始主機與 PEM CA。模擬驅動測試通過，真實 SAP ODBC 驗收待環境。 | [C2](#c2-連線與查詢逾時) |
| 10 | 進階 → Write Timeout | 部分實作 | MySQL／MariaDB 可設定待完成 socket 寫入的無進度期限（毫秒，0 停用），依寫入 callback 完成重設，逾時關閉該實體連線並回報。PostgreSQL 亦支援查詢／DDL／SQL 檔案，包含快取預備語句及原生 pg_dump 匯出，監測實際上游 socket 的待完成寫入。SQL Server 帳密查詢／交易／SQL 檔案與 TCP 原生匯出也適用。不是 SQL UPDATE 期限，也不代表交易提交；Redis TCP／TLS 全命令亦適用且不重送失敗寫入；Windows TCP 驗證已加入逐 ODBC 連線與原生匯出期限，需明確 SPN；真實 ODBC 傳輸已驗證，Windows TCP 身分端到端尚待環境。ASE 已接上逐 session TCP／TLS 期限，閒置暫停、失敗不重送；TLS 由 App 驗證原始主機與 PEM CA。模擬驅動測試通過，真實 SAP ODBC 驗收待環境。 | [C2](#c2-連線與查詢逾時) |

## 2. 資料庫 Database

| 編號 | 原清單功能 | 狀態 | 現況／缺口 | 依據 |
|---|---|---|---|---|
| 11 | 資料庫名稱 | 已實作 | 可列出／選擇 database，支援名稱輸入及 CREATE DATABASE；SQLite 使用檔案，Redis 選 DB 編號。此項不代表已有資料庫重新命名。 | [D1](#d1-資料庫瀏覽與建立) |
| 12 | 字元集 | 已實作 | MySQL／MariaDB 可在建立及資料庫屬性中設定預設 charset；PostgreSQL 可在建立時選 encoding，既有資料庫依原生限制唯讀。SQL Server 字碼頁隨定序，SQLite 既有檔案編碼唯讀；ASE 屬於伺服器整體設定。 | [D1](#d1-資料庫瀏覽與建立) |
| 13 | 定序 | 已實作 | MySQL／MariaDB 與 SQL Server 使用者資料庫可建立／修改定序，支援搜尋、SQL 預覽、版本與權限檢查。PG 可建立 locale／LC_CTYPE、15+ libc／ICU、17+ builtin，既有 locale 唯讀。SQL Server 只暫停本程式該資料庫的連線池，不強制排除其他用戶端；系統資料庫唯讀。既有欄位不隨預設值轉換。 | [D1](#d1-資料庫瀏覽與建立) |
| 14 | 功能 → 執行 SQL 檔案 | 已實作 | 資料庫選單可選檔、預覽行號與批次，再於獨立固定 session 執行，提供進度、錯誤停止／繼續與取消。支援 SQL Server／ASE GO、MySQL DELIMITER、PG dollar quote、SQLite trigger。UTF-8／BOM UTF-16，16 MiB／50000 批次上限；不執行 shell／include 等用戶端指令及 COPY FROM STDIN。已提交資料不自動回滾，ASE 仍只有模擬驅動驗證。 | [Q1](#q1-sql-查詢與檔案邊界) |
| 15 | 功能 → 匯出 SQL 檔案 → 結構和資料 | 部分實作 | SQLite／MySQL／MariaDB／PostgreSQL 提供一致性資料匯出、進度、取消與原生儲存。SQLite 保留精確值、rowid、產生欄位與序號；MySQL InnoDB 使用快照，混合 MyISAM／Aria／MEMORY／CSV／ARCHIVE 使用 READ 鎖，保留 DECIMAL、unsigned BIGINT、BIT、ENUM／SET、JSON、空間值及時間精度。16 MiB／50000 批次上限，超限不儲存半成品。SQLite 虛擬表、MariaDB system-versioned／sequence、遠端引擎尚不支援。ASE 已加入 JDK 11+／jConnect 資料匯出，唯讀交易取 SHARE 鎖、保留精確值與 identity、延後外鍵／Trigger，未知腳本排序／加密／存取規則等明確拒絕；Java JDBC 替身與共用流程已驗證，真機往返尚待環境。SQL Server 2017+ 使用共享表鎖與伺服器端值序列化，保留精確型別、字碼頁、identity／sequence；需 PowerShell 的 SMO 模組，RLS／Always Encrypted／temporal／ledger 資料另有限制。PG 使用 pg_dump 原生快照，保留精確值／陣列／bytea／大型物件，資料列數未知；需安裝原生用戶端工具。 | [Q1](#q1-sql-查詢與檔案邊界) |
| 16 | 功能 → 匯出 SQL 檔案 → 只有結構 | 部分實作 | SQLite 原生 DDL 與資料庫屬性；MySQL／MariaDB 原生 Table／Index／View／Trigger、函式及預存程序，保留 DEFINER、SQL_MODE、collation、AUTO_INCREMENT，排序檢視相依，觸發器於資料之後建立。MySQL 需還原到原名稱／定序的空白資料庫，原資料庫參照不改寫，不包含事件／授權；需有所有目標物件的 metadata 權限。PG 使用 pg_dump 保留 schema／型別／序號／函式／分割表／ACL／RLS，需先備妥角色、擴充套件與資料表空間；不包含角色建立、資料庫預設屬性、publication／subscription 及 foreign table 遠端資料。SQL Server 2017+ 使用原生 SMO 產生結構／授權／註解，需先備妥角色、filegroup 與 CLR assembly 等外部相依，不包含建庫與使用者建立。ASE 已加入原生 ddlgen 結構匯出、Java／JAR 路徑設定、取消、期限及 SQL 檔案儲存；保留 CREATE DATABASE／USE／裝置設定，還原前須檢查相依環境。Java 程序替身與 Command Bus 測試通過，SAP 工具／ASE 真機驗收仍待環境。 | [D1](#d1-資料庫瀏覽與建立)、[Q1](#q1-sql-查詢與檔案邊界) |

## 3. 資料表 Table

### 名稱與欄位

| 編號 | 原清單功能 | 狀態 | 現況／缺口 | 依據 |
|---|---|---|---|---|
| 17 | 資料表名稱 | 已實作 | 建表可指定名稱，既有資料表可透過右鍵重新命名及預覽 SQL。 | [T1](#t1-物件建立與重新命名) |
| 18 | 內容 → 欄位 → 名稱 | 已實作 | 建立、新增及修改欄位名稱；設計器可直接編輯。 | [T2](#t2-欄位與主鍵設計) |
| 19 | 內容 → 欄位 → 類型 | 已實作 | 依引擎提供型別 autocomplete，可輸入自訂型別宣告。 | [T2](#t2-欄位與主鍵設計) |
| 20 | 內容 → 欄位 → 長度 | 已實作 | 獨立長度／精度欄位；依型別啟停，支援 SQL Server MAX 等差異。不是所有型別都有長度。 | [T2](#t2-欄位與主鍵設計) |
| 21 | 內容 → 欄位 → 小數點 | 已實作 | 獨立小數位數 scale；依引擎與型別組合成宣告。 | [T2](#t2-欄位與主鍵設計) |
| 22 | 內容 → 欄位 → 不是 null | 已實作 | 介面使用「允許 NULL」，語意與「不是 null」相反；可勾選修改並產生對應 DDL。PK 強制不可 NULL。 | [T2](#t2-欄位與主鍵設計) |
| 23 | 內容 → 欄位 → 虛擬 | 已實作 | 建表表單與「產生欄位」頁可新增 generated 欄位、設定運算式與 Virtual／Stored；既有運算式可修改，SQLite／SQL Server 可切換儲存方式。MySQL／MariaDB 不直接切換既有欄位儲存方式；PG 12+ 可建立 Stored，17+ 可修改 Stored 運算式，18+ 可建立 Virtual，但不直接修改 Virtual 運算式。身份／自動遞增另行辨識；資料頁計算值唯讀。ASE 尚無本項表單。 | [T5](#t5-產生欄位) |
| 24 | 內容 → 欄位 → PK | 已實作 | 列內與屬性面板可選 PK，另有主鍵頁籤；支援複合 PK 及預覽／套用。 | [T2](#t2-欄位與主鍵設計) |
| 25 | 內容 → 欄位 → 註解 | 已實作 | 欄位選項可新增、修改及清除註解。MySQL／MariaDB 使用欄位 COMMENT，PostgreSQL 使用 COMMENT ON，SQL Server 使用 MS_Description。SQLite／ASE 不提供此表單。 | [T4](#t4-外鍵check-與資料表進階屬性) |
| 26 | 內容 → 欄位 → 預設值 | 已實作 | 可填 default SQL expression、移除或修改預設值，支援 SQL 預覽。 | [T2](#t2-欄位與主鍵設計) |
| 27 | 內容 → 欄位 → 字元集 | 已實作 | MySQL／MariaDB 文字欄位可選伺服器 charset，切換時更新可用定序；修改保留原始欄位宣告的其他屬性。其他引擎沒有逐欄 charset 選項。 | [T4](#t4-外鍵check-與資料表進階屬性) |
| 28 | 內容 → 欄位 → 定序 | 已實作 | SQLite／PostgreSQL／MySQL／MariaDB／SQL Server 可搜尋並修改原生定序；後端驗證目錄及字元集匹配。SQLite 重建表並保留資料、索引、觸發器；PG／SQL Server 產生欄位與索引相依限制由伺服器或能力檢查回報。ASE 尚不提供。 | [T4](#t4-外鍵check-與資料表進階屬性) |
| 29 | 內容 → 欄位 → 二進位 | 已實作 | MySQL／MariaDB 文字欄位提供二進位比較開關；啟用選擇 charset_bin，關閉恢復字元集預設定序，不會將文字型別改成 BLOB。不存在對應定序時拒絕套用。 | [T4](#t4-外鍵check-與資料表進階屬性) |

### 索引

| 編號 | 原清單功能 | 狀態 | 現況／缺口 | 依據 |
|---|---|---|---|---|
| 30 | 內容 → 索引 → 名稱 | 已實作 | 獨立 Index 建立分頁可指定名稱；右鍵可重新命名。不是 Table 設計器內的索引頁籤。 | [T1](#t1-物件建立與重新命名)、[T3](#t3-索引與觸發器) |
| 31 | 內容 → 索引 → 欄位 | 已實作 | 建立時可選多欄位、鍵順序與 ASC／DESC；既有索引透過 SQL 定義修改。 | [T3](#t3-索引與觸發器) |
| 32 | 內容 → 索引 → 索引類型 | 已實作 | 建立與修改表單提供 NORMAL／UNIQUE；MySQL／MariaDB 依 storage engine 提供 FULLTEXT／SPATIAL。PK 仍由資料表設計器管理，約束／分割／特殊索引沿用唯讀原因；UNIQUE 衝突會保留原索引。 | [T3](#t3-索引與觸發器) |
| 33 | 內容 → 索引 → 索引方法 | 已實作 | MySQL 一般索引可選 BTREE，MEMORY 另有 HASH；PostgreSQL 從 pg_am 讀取方法並驗證唯一性／排序能力；SQL Server／ASE 提供 CLUSTERED／NONCLUSTERED rowstore，SQLite 為 BTREE。修改保留欄位、條件與其他宣告，無法相容時由伺服器拒絕。SQL Server 聚集轉非聚集採交易內 DROP／CREATE。 | [T3](#t3-索引與觸發器) |
| 34 | 內容 → 索引 → 註解 | 已實作 | MySQL／MariaDB COMMENT、PostgreSQL COMMENT ON INDEX、SQL Server MS_Description 可建立／修改／清除並讀回。PG／SQL Server 僅改註解不重建。重建恢復既有註解；SQL Server 存在其他自訂擴充屬性時保持唯讀。SQLite／ASE 無本項原生表單。 | [T3](#t3-索引與觸發器) |

### 外部索引鍵（Foreign Key）

| 編號 | 原清單功能 | 狀態 | 現況／缺口 | 依據 |
|---|---|---|---|---|
| 35 | 內容 → 外部索引鍵 → 名稱 | 已實作 | 設計器外鍵頁提供清單、名稱、新增／修改／刪除、SQL 預覽及版本檢查；SQLite 未命名／行內外鍵亦可選取。MySQL 同名替換分段執行並提供復原計畫。 | [T4](#t4-外鍵check-與資料表進階屬性) |
| 36 | 內容 → 外部索引鍵 → 欄位 | 已實作 | 支援多欄位與依序配對；驗證欄位存在、數量一致且無重複。 | [T4](#t4-外鍵check-與資料表進階屬性) |
| 37 | 內容 → 外部索引鍵 → 受參考的結構描述 | 已實作 | 依目前引擎載入 schema，MySQL 改載入 database；SQLite 只允許同一資料庫。跨資料庫 ASE 約束保留唯讀限制。 | [T4](#t4-外鍵check-與資料表進階屬性) |
| 38 | 內容 → 外部索引鍵 → 受參考的資料表 | 已實作 | 依目標 schema 載入資料表，切換目標清除舊欄位配對；伺服器檢查目標鍵與型別相容性。 | [T4](#t4-外鍵check-與資料表進階屬性) |
| 39 | 內容 → 外部索引鍵 → 受參考的欄位 | 已實作 | 載入參考資料表欄位，可設定複合鍵的有序配對。 | [T4](#t4-外鍵check-與資料表進階屬性) |
| 40 | 內容 → 外部索引鍵 → 刪除時 | 已實作 | 依引擎列出 NO ACTION／RESTRICT／CASCADE／SET NULL／SET DEFAULT；SET NULL 需可空值欄位。ASE 只支援 NO ACTION。 | [T4](#t4-外鍵check-與資料表進階屬性) |
| 41 | 內容 → 外部索引鍵 → 更新時 | 已實作 | ON UPDATE 選單、能力驗證及 SQL 產生流程完成；SQLite、PostgreSQL、MySQL、MariaDB、SQL Server 已實測 CASCADE。 | [T4](#t4-外鍵check-與資料表進階屬性) |

### 檢查（CHECK）

| 編號 | 原清單功能 | 狀態 | 現況／缺口 | 依據 |
|---|---|---|---|---|
| 42 | 內容 → 檢查 → 名稱 | 已實作 | CHECK 頁提供清單、名稱及新增／修改／刪除；支援 SQLite 行內與未命名檢查。 | [T4](#t4-外鍵check-與資料表進階屬性) |
| 43 | 內容 → 檢查 → 檢查 | 已實作 | 運算式編輯、安全片段驗證、SQL 預覽、草稿保存及版本檢查；既有資料不符合新條件時保留原約束／資料。ASE 僅 catalog／方言模擬測試，沒有真實伺服器驗證。 | [T4](#t4-外鍵check-與資料表進階屬性) |
| 44 | 內容 → 檢查 → 不強制執行 | 已實作 | MySQL 8.0.16+ 使用 NOT ENFORCED；SQL Server 使用 NOCHECK 的停用檢查。MariaDB／SQLite／目前支援的 PostgreSQL／ASE 不提供此選項。MySQL／MariaDB 依版本判斷 CHECK 能力；重新啟用會驗證資料。 | [T4](#t4-外鍵check-與資料表進階屬性) |

### 觸發器

| 編號 | 原清單功能 | 狀態 | 現況／缺口 | 依據 |
|---|---|---|---|---|
| 45 | 內容 → 觸發器 → 名稱 | 已實作 | 獨立 Trigger 分頁可建立、編輯 SQL 定義、刪除、重新命名。尚未整合成 Table 內頁籤。 | [T1](#t1-物件建立與重新命名)、[T3](#t3-索引與觸發器) |
| 46 | 內容 → 觸發器 → 觸發 | 已實作 | 依「觸發時機」解讀：提供 BEFORE／AFTER／INSTEAD OF，依引擎與目標 Table／View 篩選。 | [T3](#t3-索引與觸發器) |
| 47 | 內容 → 觸發器 → 插入 | 已實作 | 可建立 INSERT trigger；建立表單事件是單選，不是多事件複選。 | [T3](#t3-索引與觸發器) |
| 48 | 內容 → 觸發器 → 更新 | 已實作 | 可建立 UPDATE trigger；既有物件透過 SQL 定義修改。 | [T3](#t3-索引與觸發器) |
| 49 | 內容 → 觸發器 → 刪除 | 已實作 | 可建立 DELETE trigger；仍需輸入 trigger body 或 PostgreSQL 函式。 | [T3](#t3-索引與觸發器) |

### 選項與註解

| 編號 | 原清單功能 | 狀態 | 現況／缺口 | 依據 |
|---|---|---|---|---|
| 50 | 內容 → 選項 → 引擎 | 已實作 | MySQL／MariaDB 資料表選項讀取 SHOW ENGINES，可選伺服器可用引擎並產生 ALTER TABLE ENGINE；已驗證 InnoDB ↔ MyISAM。特殊索引／外鍵限制交由伺服器檢查。 | [T4](#t4-外鍵check-與資料表進階屬性) |
| 51 | 內容 → 選項 → 字元集 | 已實作 | MySQL／MariaDB 可修改資料表預設字元集；畫面及 SQL 預覽說明僅適用新增欄位，既有欄位需個別轉換。 | [T4](#t4-外鍵check-與資料表進階屬性) |
| 52 | 內容 → 選項 → 定序 | 已實作 | MySQL／MariaDB 可搜尋、選取並修改預設定序；包含 MariaDB UCA 完整名稱，驗證 charset 匹配，不自動轉換既有欄位資料。 | [T4](#t4-外鍵check-與資料表進階屬性) |
| 53 | 內容 → 註解 | 已實作 | MySQL／MariaDB、PostgreSQL、SQL Server 資料表註解可新增、修改、清除，含 Unicode 與引號處理。SQLite／ASE 不提供此表單。 | [T4](#t4-外鍵check-與資料表進階屬性) |

## 4. 檢視 View

| 編號 | 原清單功能 | 狀態 | 現況／缺口 | 依據 |
|---|---|---|---|---|
| 54 | 檢視名稱 | 已實作 | 建立可指定名稱，既有 View 可透過重新命名對話框修改。 | [T1](#t1-物件建立與重新命名) |
| 55 | 定義 | 已實作 | 新建輸入 SELECT／CTE；既有 View 以完整定義編輯、預覽、套用，含版本衝突檢查。SQL Server indexed view 等特殊物件有唯讀限制。 | [V1](#v1-view-定義) |
| 56 | 進階 → 演算法 | 已實作 | MySQL／MariaDB 新增及修改表單可選 UNDEFINED／MERGE／TEMPTABLE，修改後讀回實際值。TEMPTABLE 與 CHECK OPTION 的不相容組合會拒絕；其他引擎不顯示此選項。 | [V1](#v1-view-定義) |
| 57 | 進階 → 定義者 | 已實作 | MySQL／MariaDB 提供目前帳號或明確帳號／主機輸入，回讀既有定義者；修改其他屬性時保留原值。帳號存在性與授權由伺服器檢查，不需列舉 mysql.user。 | [V1](#v1-view-定義) |
| 58 | 進階 → 安全性 | 已實作 | MySQL／MariaDB 可設定 SQL SECURITY DEFINER／INVOKER；PostgreSQL 15+ 對應 security_invoker，保留 owner 與其餘 reloptions。其他引擎不提供不適用的選項。 | [V1](#v1-view-定義) |
| 59 | 進階 → 檢查選項 | 已實作 | MySQL／MariaDB／PostgreSQL 可選 NONE／LOCAL／CASCADED；SQL Server／ASE 可選 NONE／CASCADED（WITH CHECK OPTION）。新增、修改、讀回及違規寫入拒絕已驗證四種網路 SQL 服務；ASE 僅語法模擬。SQLite 不支援。 | [V1](#v1-view-定義) |

## 5. 查詢

| 編號 | 原清單功能 | 狀態 | 現況／缺口 | 依據 |
|---|---|---|---|---|
| 60 | 連線 | 已實作 | 查詢分頁綁定 connectionId，由連線或物件瀏覽器開啟；分頁保留自己的來源，沒有分頁內任意改綁連線的選單。 | [Q1](#q1-sql-查詢與檔案邊界) |
| 61 | 資料庫 | 已實作 | 從指定 database 開查詢，分頁保存 database／schema，執行與結果游標遵循該範圍；側邊欄切換不改寫既有分頁來源。 | [Q1](#q1-sql-查詢與檔案邊界) |
| 62 | 語法 | 已實作 | 依 SQL 編輯／執行解讀：Monaco 語法上色、自動完成、選取執行、Ctrl／⌘+Enter、取消、結果分頁及歷史紀錄。每次執行一個 statement，不代表支援 SQL 檔案或多 batch 執行。 | [Q1](#q1-sql-查詢與檔案邊界) |

## 操作介面尚未達成的部分

1. **Table 設計器尚不是完整 Navicat 內容分頁。** 已有欄位／主鍵／外鍵／CHECK／產生欄位／欄位選項／資料表選項頁；Index、Trigger 功能由獨立物件分頁提供。本表依「功能能否完成」計算，沒有把獨立分頁誤稱為已完成指定版面。
2. **部分 Table 屬性須建立後編輯。** 一般 table／column 屬性從設計資料表入口修改，新建物件使用預設值後再編輯。產生欄位、Index／View 選項、database 字元集與定序可直接在建立表單設定。
3. **SQL 匯出已有 SQLite／MySQL／MariaDB／PostgreSQL／SQL Server 路徑，跨引擎仍有缺口。** 支援原生 DDL、結構／資料兩種模式、進度、取消及原生儲存；ASE 已接入原生結構與 JDBC 資料匯出，但原生腳本排序、精確值往返及不同版本相容性尚待真機驗證；不以已通過引擎推論其他引擎可用。
4. **連線進階設定仍有缺口。** Heartbeat Interval 已依澄清完成；Read／Write Timeout 已完成 MySQL／MariaDB、PostgreSQL 與 SQL Server 帳密查詢／DDL／SQL 檔案，以及 Redis 全命令的 socket 路徑；SQL Server 帳密 TCP 原生匯出亦已接上；Windows TCP 驗證已有 ODBC／原生匯出實作與 SPN 設定，身分驗證端到端尚待環境；ASE 已加入逐 session 期限與 TCP／TLS 模擬驅動驗證，仍待 SAP ODBC 真機驗收。可選用戶端字元集目前支援 MySQL／MariaDB、Redis、PostgreSQL 與 ASE JDBC；SQL Server 依 Unicode／欄位定序處理，沒有同名連線級設定。ASE ODBC 保持 UTF-8，另有八種 JDBC 編碼與 JDK／JAR 設定，Java 替身、TCP／TLS 與桌面測試通過；仍缺 SAP 真機相容性證據。

後續驗收：ASE ODBC／JDBC 字元集、期限與原生匯出還原；Windows TCP 身分驗證及原生匯出。這些路徑已有實作與替身／部分傳輸測試，仍缺對應真實環境證據，不能以目前通過的測試取代。

## 程式碼與既有驗證依據

### C1 連線表單與模型

- [ConnectionForm.tsx](../../src/renderer/src/components/ConnectionForm.tsx)：名稱、Host、Port、帳密、TLS、資料庫與 ASE／SQL Server 選項。
- [types.ts](../../src/shared/types.ts)：Connection 公開模型與 Settings。
- [connection-service.ts](../../src/main/application/services/connection-service.ts)：儲存、取得憑證、測試及連線生命週期。
- [client-encodings.ts](../../src/shared/client-encodings.ts)、[text-codec.ts](../../src/main/database/adapters/redis/text-codec.ts)：Redis 八種可選編碼、精確轉換與 JSON／SCAN 的編碼規則。
- [text-protocol.ts](../../src/main/database/adapters/postgres/text-protocol.ts)、[postgres-encoding.test.ts](../../tests/postgres-encoding.test.ts)：PostgreSQL 八種協定文字編碼、二進位參數保留、分片封包、有界 portal、TLS 與真實資料庫往返；SQL 匯出仍使用 UTF-8。
- 既有驗證：[smoke-connections.mjs](../../scripts/smoke-connections.mjs)、[sqlserver-auth.test.ts](../../tests/sqlserver-auth.test.ts)。

- [jdbc-session.ts](../../src/main/database/adapters/sybase/jdbc-session.ts)、[AseQuerySession.java](../../src/main/database/adapters/sybase/AseQuerySession.java)、[sybase-jdbc.test.ts](../../tests/sybase-jdbc.test.ts)：ASE 八種 JDBC 編碼、精確值、獨立 session／TLS／期限與腳本批次狀態；Java Driver 契約替身驗證，SAP 真機尚待環境。

### C2 連線與查詢逾時

- [mysql-adapter.ts](../../src/main/database/adapters/mysql/mysql-adapter.ts)、[postgres-adapter.ts](../../src/main/database/adapters/postgres/postgres-adapter.ts)、[sqlserver-adapter.ts](../../src/main/database/adapters/sqlserver/sqlserver-adapter.ts)、[redis-adapter.ts](../../src/main/database/adapters/redis/redis-adapter.ts)、[sybase-adapter.ts](../../src/main/database/adapters/sybase/sybase-adapter.ts)：可設定連線逾時、MySQL charset 與查詢取消／期限；Redis／ASE 提供專用 heartbeat。
- [connection-options.test.ts](../../tests/connection-options.test.ts)：舊設定相容、參數界線、Heartbeat 不重疊／停止／失敗及重連測試。
- [odbc-timeouts.ts](../../src/main/database/adapters/sqlserver/odbc-timeouts.ts)、[transport.ts](../../src/main/database/adapters/sqlserver/transport.ts)：Windows TCP 的逐連線轉送、SPN／TLS 身分分離與閒置／暫停處理；[sqlserver-odbc-io.test.ts](../../tests/sqlserver-odbc-io.test.ts) 使用真實 ODBC 驅動與 SQL Server 驗證傳輸（測試登入採 SQL 帳密）。Windows TCP 身分端到端案例已備妥，尚缺可用環境。
- [socket-timeouts.ts](../../src/main/database/adapters/network/socket-timeouts.ts)、[MySQL socket-timeouts.ts](../../src/main/database/adapters/mysql/socket-timeouts.ts)：實體 socket 收取／寫入期限、結果背壓、關閉清理及 MySQL 連線錯誤傳遞；[PostgreSQL socket-timeouts.ts](../../src/main/database/adapters/postgres/socket-timeouts.ts) 依協定發送／ReadyForQuery 控制期限；[SQL Server socket-timeouts.ts](../../src/main/database/adapters/sqlserver/socket-timeouts.ts) 追蹤 Tedious 實體請求／交易與結果暫停。
- [socket-timeouts.test.ts](../../tests/socket-timeouts.test.ts)：TCP 分塊接收與閒置、暫停消費、待完成寫入、TLS 憑證驗證與逾時，MySQL／MariaDB 真實查詢／SQL 檔案／匯出期限，PostgreSQL 查詢／DDL／SQL 檔案、通知分塊、排隊與預備語句，以及 SQL Server 帳密的查詢／交易／SQL 檔案、持續 NOTICE、暫停讀取與錯誤恢復；[smoke-connection-options.mjs](../../scripts/smoke-connection-options.mjs) 驗證保存與中文桌面流程。
- [capture-client-socket.ts](../../src/main/database/adapters/network/capture-client-socket.ts)、[redis-io.test.ts](../../tests/redis-io.test.ts)：Redis socket 範圍隔離、登入上限、TCP／TLS 分塊接收、讀寫期限與不重送已完成寫入。
- [native-relay.ts](../../src/main/database/adapters/network/native-relay.ts)、[pg-dump.ts](../../src/main/database/adapters/postgres/pg-dump.ts)：原生匯出的短期 loopback 轉送、實際上游 socket 讀寫期限、輸出背壓與關閉清理。pg_dump 保留原 host／verify-full，TLS 端到端驗證不交由轉送層；[native-relay.test.ts](../../tests/native-relay.test.ts)、[postgres-export.test.ts](../../tests/postgres-export.test.ts) 驗證實際 transport、原生匯出等待鎖逾時、TLS 信任與名稱不符拒絕。
- [sql-export.ts](../../src/main/database/adapters/sqlserver/sql-export.ts)、[sql-export.ps1](../../src/main/database/adapters/sqlserver/sql-export.ps1)：SQL Server 帳密 TCP 原生匯出期限、HostNameInCertificate 與明確登入錯誤；[sqlserver-export.test.ts](../../tests/sqlserver-export.test.ts) 驗證精確還原、鎖定逾時、憑證拒絕及取消清理。
- [SettingsPanel.tsx](../../src/renderer/src/components/SettingsPanel.tsx)、[query-service.ts](../../src/main/application/services/query-service.ts)：全域 queryTimeout。
- [redis-service.ts](../../src/main/application/services/redis-service.ts)：key TTL／PERSIST／EXPIRE，屬於資料操作。

### D1 資料庫瀏覽與建立

- [DatabaseExplorer.tsx](../../src/renderer/src/components/DatabaseExplorer.tsx)、[RedisExplorer.tsx](../../src/renderer/src/components/RedisExplorer.tsx)：資料庫名稱輸入／列表及 Redis DB。
- [application.ts](../../src/main/application/application.ts)：共用 database.options／database.create；建立接受 charset／collation／PG locale 選項，遵循 DDL 權限；database.properties.describe／preview／apply 提供屬性編輯，套用遵循 destructive 權限。
- [DatabasePropertiesDialog.tsx](../../src/renderer/src/components/DatabasePropertiesDialog.tsx)、[database-properties.ts](../../src/main/database/database-properties.ts)：屬性入口、讀回、唯讀能力、版本與伺服器選項驗證。
- [database-properties.test.ts](../../tests/database-properties.test.ts)、[smoke-database-properties.mjs](../../scripts/smoke-database-properties.mjs)：四個資料庫服務與桌面驗證。
- [create-database.ts](../../src/main/database/create-database.ts)、[database-options.ts](../../src/shared/database-options.ts)：伺服器選項、嚴格驗證與各引擎 CREATE DATABASE。
- [integration.test.ts](../../tests/integration.test.ts)、[redis-encoding.test.ts](../../tests/redis-encoding.test.ts)、[smoke-connection-options.mjs](../../scripts/smoke-connection-options.mjs)：實際 session 字元集、新建資料庫 metadata、Redis 八種編碼與 JSON UTF-8，以及桌面設定／選單流程。
- 既有驗證：[database-create.test.ts](../../tests/database-create.test.ts)、[redis-databases.test.ts](../../tests/redis-databases.test.ts)。

### T1 物件建立與重新命名

- [CreateObjectView.tsx](../../src/renderer/src/components/CreateObjectView.tsx)、[create-object.ts](../../src/shared/create-object.ts)、[create-object-service.ts](../../src/main/application/services/create-object-service.ts)：建立表單、嚴格參數模型及 DDL。
- [RenameObjectDialog.tsx](../../src/renderer/src/components/RenameObjectDialog.tsx)、[rename-object-service.ts](../../src/main/application/services/rename-object-service.ts)：四類物件重新命名。
- 既有驗證：[create-objects.test.ts](../../tests/create-objects.test.ts)、[rename-objects.test.ts](../../tests/rename-objects.test.ts)。

### T2 欄位與主鍵設計

- [TableDesigner.tsx](../../src/renderer/src/components/TableDesigner.tsx)、[ColumnTypeEditor.tsx](../../src/renderer/src/components/ColumnTypeEditor.tsx)、[column-types.ts](../../src/renderer/src/column-types.ts)：可操作欄位與型別／長度／scale。
- [types.ts](../../src/shared/types.ts)：StructureColumn 與 StructureChange，包含 FK／CHECK、產生欄位與 charset／comment 等屬性變更。
- [table-structure-service.ts](../../src/main/application/services/table-structure-service.ts)、[structure-sql.ts](../../src/main/database/structure-sql.ts)：generated 辨識、屬性修改、既有宣告保留與引擎限制。
- 既有驗證：[table-structure.test.ts](../../tests/table-structure.test.ts)、[column-types.test.ts](../../tests/column-types.test.ts)、[smoke-structure.mjs](../../scripts/smoke-structure.mjs)。

### T3 索引與觸發器

- [CreateObjectView.tsx](../../src/renderer/src/components/CreateObjectView.tsx)、[create-object-service.ts](../../src/main/application/services/create-object-service.ts)：索引鍵順序／UNIQUE，以及 Trigger timing／單一 event／body。
- [DatabaseObjectView.tsx](../../src/renderer/src/components/DatabaseObjectView.tsx)、[database-object-service.ts](../../src/main/application/services/database-object-service.ts)：索引／Trigger SQL 定義編輯，MySQL 索引子句處理及 PostgreSQL 註解保留。
- [IndexOptionsForm.tsx](../../src/renderer/src/components/IndexOptionsForm.tsx)、[index-options.ts](../../src/main/database/index-options.ts)：類型／方法／註解表單、server capability、metadata、片段替換與原生註解 DDL，沿用 object.preview／apply、版本與權限。
- [index-options.test.ts](../../tests/index-options.test.ts)、[smoke-index-options.mjs](../../scripts/smoke-index-options.mjs)：SQLite／PostgreSQL／MySQL／MariaDB／SQL Server 的唯一性、失敗保留、方法切換、註解讀回／清除、版本衝突；另驗證 GIN、FULLTEXT／SPATIAL、MEMORY HASH、NO_BACKSLASH_ESCAPES、SQL Server 註解恢復及自訂屬性保護。ASE 僅語法模擬。桌面驗證表單建立／修改、草稿 reload、SQL 互斥及繁中介面。
- 既有回歸：[database-object-edit.test.ts](../../tests/database-object-edit.test.ts)、[smoke-object-tabs.mjs](../../scripts/smoke-object-tabs.mjs)。

### T4 外鍵、CHECK 與資料表進階屬性

- [ConstraintDesigner.tsx](../../src/renderer/src/components/ConstraintDesigner.tsx)、[constraints.ts](../../src/shared/constraints.ts)：外鍵／CHECK 頁及共用輸入契約。
- [constraint-catalog.ts](../../src/main/database/constraint-catalog.ts)、[constraint-plan.ts](../../src/main/database/constraint-plan.ts)：五類 SQL 引擎 metadata／DDL、SQLite 行內及未命名約束解析、引擎／版本能力檢查。保護延後檢查、MATCH、NOT VALID、複寫等特殊語意，不以一般表單覆寫。
- [constraints.test.ts](../../tests/constraints.test.ts)、[smoke-constraints.mjs](../../scripts/smoke-constraints.mjs)：SQLite 與四個網路 SQL 服務驗證新增／修改／刪除、約束強制執行、複合 FK、CASCADE／SET NULL、失敗復原、權限及桌面草稿。
- [StructureProperties.tsx](../../src/renderer/src/components/StructureProperties.tsx)、[structure-properties.ts](../../src/main/database/structure-properties.ts)：欄位／資料表屬性表單、server catalog、方言與字串處理。沿用共享 structure.preview／apply、版本檢查與破壞性操作核准。
- [structure-properties.test.ts](../../tests/structure-properties.test.ts)、[smoke-structure-properties.mjs](../../scripts/smoke-structure-properties.mjs)：跨服務屬性回讀、資料／預設值／PK 保留、註解新增修改清除、SQLite 唯一性衝突回滾及桌面操作。

### T5 產生欄位

- [generated-columns.ts](../../src/main/database/generated-columns.ts)：獨立 generation metadata、版本能力、SQL 運算式驗證、生成欄位新增及修改計畫；沿用 structure 命令、草稿、權限及版本檢查。
- [GeneratedColumnDesigner.tsx](../../src/renderer/src/components/GeneratedColumnDesigner.tsx)、[CreateObjectView.tsx](../../src/renderer/src/components/CreateObjectView.tsx)：設計器與建表表單，按引擎顯示儲存方式及型別推導提示。
- [generated-columns.test.ts](../../tests/generated-columns.test.ts)、[smoke-generated-columns.mjs](../../scripts/smoke-generated-columns.mjs)：五種服務的新增／修改／刪除、計算值、失敗回滾、SQLite rowid／自動編號／索引／觸發器保留、SQL Server 註解保留及資料寫入防護。
- SQL Server 表達式替換在同一交易內 drop/add，欄位移至最後；相依索引或約束會阻止變更。有自訂欄位權限或非 MS_Description 擴充屬性時拒絕替換，避免遺失。ASE 本項仍未開放；PostgreSQL 18 能力由版本分支與測試證明，真實整合服務目前為 PostgreSQL 17。

### V1 View 定義

- [ViewOptionsForm.tsx](../../src/renderer/src/components/ViewOptionsForm.tsx)：新增及修改共用檢視選項表單，依引擎／版本顯示演算法、定義者、安全性與 CHECK OPTION。
- [StructureEditor.tsx](../../src/renderer/src/components/StructureEditor.tsx)、[table-structure-service.ts](../../src/main/application/services/table-structure-service.ts)：完整 View 定義編輯、MySQL SHOW CREATE VIEW 及 viewPlan 保留 header／body。
- [view-options.ts](../../src/main/database/view-options.ts)：能力、metadata 讀回與原生 DDL，沿用共用 structure 預覽／套用、版本及 DDL 權限；不透過刪除檢視重新建立來改屬性。
- [view-options.test.ts](../../tests/view-options.test.ts)、[smoke-view-options.mjs](../../scripts/smoke-view-options.mjs)：真實 CHECK OPTION 寫入阻擋、選項讀回、版本衝突、PG reloptions／註解與 PG／SQL Server 授權保留，以及桌面建立／修改／草稿恢復／繁中介面。SQL Server indexed view 保持唯讀；ASE 無真實服務驗證。

### Q1 SQL 查詢與檔案邊界

- [QueryView.tsx](../../src/renderer/src/components/QueryView.tsx)、[SqlEditor.tsx](../../src/renderer/src/components/SqlEditor.tsx)、[WorkspaceScope.tsx](../../src/renderer/src/components/WorkspaceScope.tsx)：查詢編輯與來源。
- [workspace-service.ts](../../src/main/application/services/workspace-service.ts)、[query-service.ts](../../src/main/application/services/query-service.ts)、[single-statement.ts](../../src/main/security/single-statement.ts)：分頁 scope、執行與單一 statement 邊界。
- [index.ts](../../src/main/index.ts)、[application.ts](../../src/main/application/application.ts)：原生 SQL 選檔僅供桌面使用者；共用 script.preview／execute／status／cancel，沿用固定 IPC、授權與稽核。
- [SqlScriptDialog.tsx](../../src/renderer/src/components/SqlScriptDialog.tsx)、[sql-script-service.ts](../../src/main/application/services/sql-script-service.ts)、[sql-script-parser.ts](../../src/main/database/sql-script-parser.ts)：預覽、分段、獨立固定 session、進度、錯誤處理與取消。
- [sql-script.test.ts](../../tests/sql-script.test.ts)、[smoke-sql-file.mjs](../../scripts/smoke-sql-file.mjs)：五種服務的實際資料、交易與生命週期，以及桌面檔案讀取流程。
- [SqlExportDialog.tsx](../../src/renderer/src/components/SqlExportDialog.tsx)、[sql-export-service.ts](../../src/main/application/services/sql-export-service.ts)、[export-process.ts](../../src/main/database/adapters/sqlite/export-process.ts)：共用 export.start／status／read／cancel／release 命令、擁有者與即時權限檢查、分批暫存及桌面原子儲存；SQLite 使用可取消的獨立唯讀程序與一致性快照。
- [sql-export.test.ts](../../tests/sql-export.test.ts)、[smoke-sql-export.mjs](../../scripts/smoke-sql-export.mjs)：SQLite UTF-8／UTF-16 精確值與物件往返、同時寫入、取消、權限撤銷、暫存清理、超限拒絕，以及桌面兩種匯出模式／儲存／重新匯入。
- [sql-export.ts](../../src/main/database/adapters/mysql/sql-export.ts)、[view-dependencies.ts](../../src/main/database/adapters/mysql/view-dependencies.ts)：MySQL 原生 metadata 與值序列化、RR 快照／混合引擎 READ 鎖、資料串流、SQL_MODE／定序保留、檢視及 CTE 相依判斷、匯出後 live catalog 複核。SQL 檔案用獨立 UTF-8 session，避免來源連線的 legacy charset 破壞 Unicode。
- [mysql-export.test.ts](../../tests/mysql-export.test.ts)、[smoke-mysql-export.mjs](../../scripts/smoke-mysql-export.mjs)：MySQL 8.4／MariaDB 11.4 精確值、物件、CTE、字元集、snapshot、READ 鎖及取消；桌面儲存、超限後改為結構匯出及重新匯入。
- [pg-dump.ts](../../src/main/database/adapters/postgres/pg-dump.ts)、[postgres-export.test.ts](../../tests/postgres-export.test.ts)、[smoke-postgres-export.mjs](../../scripts/smoke-postgres-export.mjs)：原生工具偵測／路徑設定、受控子程序、串流與取消，PostgreSQL schema／型別／分割表／序號／ACL／RLS／大型物件及精確 CRLF 往返；桌面兩種模式／原生儲存／共用命令匯入／繁中畫面。
- [sql-export.ts](../../src/main/database/adapters/sqlserver/sql-export.ts)、[sql-export.ps1](../../src/main/database/adapters/sqlserver/sql-export.ps1)、[sql-export-data.ps1](../../src/main/database/adapters/sqlserver/sql-export-data.ps1)：SMO 原生結構、伺服器端精確 literal、共享表鎖、PowerShell 路徑與 stdin 憑證、背壓、取消及工具逾時。
- [sqlserver-export.test.ts](../../tests/sqlserver-export.test.ts)、[smoke-sqlserver-export.mjs](../../scripts/smoke-sqlserver-export.mjs)：SQL 帳密／Windows 身分的精確資料、字碼頁、空間型別、identity／sequence、鎖與 RLS 邊界，以及桌面設定／兩種模式／原生儲存／共用命令匯入／繁中畫面。
- 既有驗證：[smoke-electron.mjs](../../scripts/smoke-electron.mjs)、[smoke-scopes.mjs](../../scripts/smoke-scopes.mjs)。

歷史測試成果可參閱 [IMPLEMENTATION.md](implementation-log.md)。其中各段落記錄的是當時迭代，例如舊 CRUD 盤點曾將重新命名列為未來項目；本表以目前程式及後續重新命名實作為準。
