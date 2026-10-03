# Table / View 結構編輯

在資料表名稱按右鍵，選擇「設計資料表」即可開啟設計器；已開啟的資料表沿用同一分頁，也可從「結構」頁進入。

結構變更提示固定顯示於工具列「重新整理結構」左側。點選提示會開啟浮動細項，列出欄位、變更項目及前後值（包含 PK 隱含的 NOT NULL）；Esc、關閉鈕或點選外部可收起。待套用、套用成功及錯誤訊息不再插入編輯區，避免推移欄位列表。

「欄位」頁可直接在每列編輯名稱、型別、長度／精度、小數位數，並勾選允許 NULL 及 PK；選取後也可使用下方屬性面板設定 SQL 預設值。型別自動完成依 SQLite、MySQL／MariaDB、PostgreSQL、SQL Server 提供不同清單，同時接受自訂型別及完整宣告。方向鍵可切換欄位。新增欄位會顯示草稿列，也能勾選 PK 加入主鍵；套用前都不會修改資料庫。

每列的 PK、下方「此欄位為主鍵」與「主鍵」頁同步，支援複合主鍵；新的主鍵順序依勾選次序決定。勾選 PK 後不可 NULL，後端在同一變更中處理 NOT NULL；取消尚未套用的 PK 會還原原本的 NULL 狀態。既有 metadata 僅提供主鍵成員，清單依資料表欄位順序呈現，不宣稱反映原主鍵索引順序。

名稱、型別、NULL、預設值與主鍵可跨欄位連續修改，再按「預覽變更」檢查完整 SQL，最後按「套用變更」送出。手動改回原值只移除該屬性的變更，不影響其他草稿。新增／刪除欄位仍分開處理；「還原變更」、關閉及重新整理仍保留確認。View 的右鍵入口是「設計檢視」，使用完整 SQL 定義編輯器。

數字欄位依型別支援情況啟用：VARCHAR 使用長度，DECIMAL／NUMERIC 使用精度與小數位數，SQL Server FLOAT 使用精度而非小數位數；VARCHAR／NVARCHAR／VARBINARY 支援 MAX。MySQL 整數顯示寬度與 FLOAT(M,D) 為舊式語法，顯示寬度不改變整數範圍；SQLite 不強制長度與精度限制。ENUM、自訂型別等複雜宣告保留完整文字輸入，不拆解字串參數。

型別參考：[MySQL](https://dev.mysql.com/doc/refman/8.4/en/numeric-type-syntax.html)、[PostgreSQL](https://www.postgresql.org/docs/current/datatype-numeric.html)、[SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/data-types/float-and-real-transact-sql?view=sql-server-ver17)、[SQLite](https://www.sqlite.org/datatype3.html)。

## 引擎處理

| 引擎            | Table                                                                                                                                                              | View                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| SQLite          | 新增／改名／刪除使用原生 ALTER TABLE；型別、NULL、預設值及主鍵以交易重建，保留資料、rowid、AUTOINCREMENT 高水位、產生欄位、索引及 Trigger，提交前檢查外鍵及 View。 | 同一交易 drop/create，保留其 Trigger，驗證 View 可解析。                                     |
| PostgreSQL      | 原生 ALTER TABLE / ALTER COLUMN，保留完整型別長度與精度；相依性或資料轉型不允許時由伺服器拒絕。                                                                    | CREATE OR REPLACE VIEW，保留現有選項及權限；既有輸出欄位名稱、順序及型別須符合原生替換規則。 |
| MySQL / MariaDB | 一次一個 ALTER TABLE；MODIFY COLUMN 只替換目標屬性，其他欄位屬性從 SHOW CREATE TABLE 保留。DDL 隱含提交。                                                          | 使用帶有原 ALGORITHM、DEFINER、SQL SECURITY 的 ALTER VIEW。                                  |
| SQL Server      | ALTER COLUMN、DEFAULT constraint 與主鍵 constraint 操作；改名使用 sp_rename。單一 session 交易。                                                                   | ALTER VIEW，保留 ANSI_NULLS／QUOTED_IDENTIFIER 設定與既有權限。                              |

SQLite 重建時，資料先備份到同一 session 的暫存資料表，再建立新結構與搬回資料；索引／Trigger 在資料搬移後還原，避免重複觸發。外鍵在交易外停用、提交前檢查、結束後復原；不使用會對子表造成 cascade delete 的開啟外鍵 drop/recreate。

## 操作與限制

- 欄位屬性使用 `edit-columns` 合併草稿，兼容舊版單項草稿；預覽不執行 DDL。先修改屬性，最後執行改名；SQLite 合併為一次重建。SQLite／PostgreSQL／SQL Server 整批在交易內執行；MySQL／MariaDB 合併為單一 ALTER TABLE，維持既有 DDL 隱含提交限制。SQL Server 型別變更會先移除該欄位的預設值約束，再恢復原值或指定的新值。
- 刪除欄位會移除其資料；型別轉換可能改變資料意義。這兩種操作及主鍵替換按 destructive policy 核准，其他操作按 DDL policy 核准。
- 變更透過 `structure.describe`、`structure.preview`、`structure.apply` 共用 Command Bus，沿用固定 IPC、權限、核准與 audit。暫時授權綁定完整變更內容。
- 套用前重讀並比對結構版本；這是樂觀檢查，不是跨外部 session 的排他鎖。草稿及基準版本保存到工作區，重新載入可繼續。
- 未儲存的資料列修改與結構修改不能互相切換；先套用或還原，可避免拿舊欄位或主鍵寫入資料。套用後資料頁刷新欄位並清除過期排序／篩選。
- 產生欄位在獨立「產生欄位」頁設定運算式與儲存方式，也能在新建資料表時指定；identity／自動遞增與 SQLite 虛擬表仍需要專用 DDL。PostgreSQL 17+ 支援修改 Stored 運算式，MySQL 不直接切換既有 Virtual／Stored。SQL Server 替換運算式會在交易內 drop/add，欄位位置移至最後；詳細引擎差異見 README「產生欄位」。
- SQL Server 索引 View 暫不直接覆蓋，因 ALTER VIEW 會移除索引，需先制定明確的索引重建計畫。加密或無權讀取定義的 View 顯示原因。
- View 欄位由 SELECT 決定，因此使用 View SQL 編輯，不直接改欄位型別。
- View 另有「檢視選項」表單：MySQL／MariaDB 的 ALGORITHM、DEFINER 帳號／主機、SQL SECURITY 與 CHECK OPTION；PostgreSQL 的 CHECK OPTION 與 15+ security_invoker；SQL Server／ASE 的 WITH CHECK OPTION。只顯示引擎支援的選項。SQLite 沒有這些屬性。
- 選項修改使用 `view-options` 草稿，沿用結構版本、預覽／套用與 DDL 權限。SQL 定義與選項不可同時累積草稿，切換前先套用或還原；設定直接修改既有檢視，保留未變動的定義及屬性。MySQL TEMPTABLE 不接受 CHECK OPTION；實際可更新性與定義者權限由伺服器驗證。
- 既有約束、外鍵、相依物件不會被隱含 CASCADE 刪除；不相容變更由資料庫拒絕，使用者可先調整相依物件。
- 改名使用原生規則；SQL Server 等引擎不會自動改寫相依查詢／模組內容，需同步管理。
- PostgreSQL 型別轉換使用隱含 cast；需要自訂 USING 表達式的轉換可在 SQL 分頁明確執行。

## 官方參考

- [SQLite ALTER TABLE / schema change](https://www.sqlite.org/lang_altertable.html)
- [PostgreSQL ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html)、[CREATE VIEW](https://www.postgresql.org/docs/current/sql-createview.html)
- [MySQL ALTER TABLE](https://dev.mysql.com/doc/refman/8.4/en/alter-table.html)、[ALTER VIEW](https://dev.mysql.com/doc/refman/8.4/en/alter-view.html)
- [SQL Server ALTER TABLE](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql)、[ALTER VIEW](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-view-transact-sql)

## 驗證命令

`npm test`、`npm run test:integration`、`npm run test:desktop:structure`。桌面測試使用獨立 SQLite 測試檔。
