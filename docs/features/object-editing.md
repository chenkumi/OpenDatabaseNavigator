# Index / Trigger 編輯

## 功能分析

Index 用來支援資料尋找、排序及唯一性；修改欄位或索引方法通常涉及重建。Trigger 在指定事件發生時執行資料庫邏輯，修改它會影響之後的資料操作。兩者均屬 schema DDL，因此編輯頁採引擎原生 SQL 定義，而不是共用一組會遺失引擎特性的簡化欄位。

- SQLite：索引可包含多欄、expression、partial predicate、unique。Trigger 為逐列執行，可使用 BEFORE／AFTER，檢視可使用 INSTEAD OF；body 可有多個敘述。
- PostgreSQL：索引有 B-tree、hash、GiST、SP-GiST、GIN、BRIN 等方法，以及 INCLUDE、partial predicate、expression。Trigger 可逐列或逐敘述觸發，呼叫獨立的 trigger function；修改觸發事件與修改函式內容是不同操作。
- MySQL／MariaDB：索引可有欄位前綴、unique、fulltext／spatial 與引擎／版本選項。Trigger 逐列執行，有 BEFORE／AFTER；同事件同時機的多個 trigger 需保留執行順序、definer 與建立時的 SQL mode。
- SQL Server：一般 rowstore index 區分 clustered／nonclustered，支援 INCLUDE、filtered index 與儲存選項。DML trigger 以敘述為單位，透過 inserted／deleted 資料集處理多列；也有資料庫／伺服器層級 DDL／logon trigger，本頁以 table／view 的 T-SQL trigger 為編輯範圍。
- Redis：此專案的 Redis adapter 使用 key／value 資料型別介面，沒有對應的 SQL Index／Trigger 定義。

## 引擎差異與實作

| 引擎            | Index                                                                                                                                                | Trigger                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| SQLite          | 編輯 CREATE INDEX；以同一交易 drop/create，保留 expression、partial、unique。自動 constraint index 不可獨立修改。                                    | 編輯 CREATE TRIGGER，支援 BEGIN/END 多敘述 body；同一交易替換。                                                           |
| PostgreSQL      | 編輯 pg_get_indexdef 的完整定義，同一交易替換；constraint/partition 附屬索引需由原約束管理。                                                         | 編輯 pg_get_triggerdef 定義，同一交易替換；執行的 function 是另一個物件，此頁不改 function body。                         |
| MySQL / MariaDB | 從 SHOW CREATE TABLE 取得索引子句，使用單一 ALTER TABLE DROP INDEX / ADD，保留 prefix、expression、排序與引擎選項。PRIMARY KEY 由資料表約束管理。    | SHOW CREATE TRIGGER 保留 definer/body；MySQL 必須 drop/create，DDL 非跨語句交易。失敗時嘗試還原舊定義，明確回報還原結果。 |
| SQL Server      | 從 catalog 產生 rowstore CREATE INDEX，含 unique、clustered、include、filter、選項與 data space；以 DROP_EXISTING 更新。特殊索引不以不完整腳本覆蓋。 | 保留模組定義，以 ALTER TRIGGER 更新；保留 disabled、ANSI_NULLS、QUOTED_IDENTIFIER 狀態。                                  |
| Redis           | 無 SQL Index / Trigger。                                                                                                                             | 無 SQL Index / Trigger。                                                                                                  |

## 共用要求

- 物件分頁有 SQL 定義編輯、還原、SQL 預覽與套用功能；不可編輯物件附原因。
- 名稱、schema、所屬資料表保持固定，避免誤改另一個物件。更名／搬移不屬於定義編輯。
- 主程序重讀原定義並比對版本，偵測已發生的外部定義變更（樂觀檢查，不取代外部排他鎖）；套用經 Command Bus 的 DDL policy、核准與 audit。
- 支援複合 trigger body，不放寬一般 query.execute 的單一敘述規則。
- 使用同一資料庫 session 執行原子 DDL；不在 pool 的任意連線之間送 BEGIN/COMMIT。
- 尚未套用的內容標記 dirty；錯誤保留草稿，重整／關閉需確認捨棄。
- 必須驗證實際引擎的索引定義、trigger 行為、失敗還原、權限與桌面操作。

## 官方依據

- [SQLite CREATE INDEX](https://www.sqlite.org/lang_createindex.html)、[CREATE TRIGGER](https://www.sqlite.org/lang_createtrigger.html)
- [PostgreSQL ALTER INDEX](https://www.postgresql.org/docs/current/sql-alterindex.html)、[CREATE TRIGGER](https://www.postgresql.org/docs/current/sql-createtrigger.html)
- [MySQL Trigger syntax](https://dev.mysql.com/doc/refman/8.4/en/trigger-syntax.html)
- [MariaDB CREATE TRIGGER](https://mariadb.com/docs/server/server-usage/triggers-events/triggers/create-trigger)
- [SQL Server ALTER INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-index-transact-sql)、[ALTER TRIGGER](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-trigger-transact-sql)

## 明確限制

索引分頁另提供類型／方法／註解表單，與原始 SQL 互斥編輯並共用草稿和基準版本。索引方法依目標資料表／引擎能力驗證；MySQL FULLTEXT／SPATIAL 由類型選單指定，PostgreSQL 從 pg_am 讀取方法。SQL Server CLUSTERED → NONCLUSTERED 使用交易內 DROP／CREATE 並恢復 MS_Description；有其他自訂擴充屬性時先保持唯讀。引擎對照與驗證命令見 README「索引進階選項」。

- 此頁修改既有物件的定義；名稱及所屬資料表保持固定。
- SQLite 的自動索引、PostgreSQL 的 constraint／partition／replica-identity 索引、MySQL 主鍵，以及 SQL Server 的 constraint／partitioned／特殊類型索引保留為唯讀並提供原因，須在資料表約束或專用 DDL 中管理。
- SQL Server encrypted／CLR／非 table/view trigger 的完整 T-SQL 不一定可讀取，不提供不完整定義的覆蓋操作。
- PostgreSQL 使用交易重建，因此不提供 CONCURRENTLY；函式內容仍在一般 SQL 分頁修改。
- MySQL 的 DDL 失敗還原屬補償操作，無法涵蓋斷線／伺服器中止等情況；原定義保留於頁面供復原。
- 定義編輯使用有標籤的 SQL 文字區，支援鍵盤及複製貼上；使用者編輯完整引擎語法，伺服器負責語法及相依性驗證。

補充官方文件：[PostgreSQL CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html)、[MySQL CREATE INDEX](https://dev.mysql.com/doc/refman/8.4/en/create-index.html)、[SQL Server CREATE TRIGGER](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-trigger-transact-sql)。
