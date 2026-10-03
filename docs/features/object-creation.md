# 物件建立功能與資料庫差異

新增入口位於資料庫瀏覽器的 Table／View／Index／Trigger 群組右側「＋」，也可在群組上按右鍵。入口綁定所在資料庫；分頁可選 Schema，已有選取範圍時預先帶入。Redis 不提供 SQL 物件入口。

| 引擎           | Table                           | View                                         | Index                                                | Trigger                                                                                              |
| -------------- | ------------------------------- | -------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| SQLite         | 型別宣告、NULL、預設值、複合 PK | SELECT 定義，唯讀；可另建 INSTEAD OF Trigger | 一般／唯一、多欄位 ASC／DESC                         | 資料表 BEFORE／AFTER；View INSTEAD OF；逐列 NEW／OLD                                                 |
| PostgreSQL     | 型別、NULL、預設值、複合 PK     | SELECT／CTE 定義                             | 一般／唯一、多欄位 ASC／DESC；索引繼承資料表 Schema  | 資料表 BEFORE／AFTER；View INSTEAD OF；逐列，可同交易建立 PL/pgSQL 函式或引用既有零參數 trigger 函式 |
| MySQL／MariaDB | 型別、NULL、預設值、複合 PK     | SELECT 定義，伺服器判定可更新性              | 一般／唯一、多欄位 ASC／DESC；伺服器版本決定排序支援 | 僅資料表 BEFORE／AFTER，逐列 NEW／OLD；不提供 View Trigger                                           |
| SQL Server     | 型別、NULL、預設值、複合 PK     | SELECT／CTE 定義                             | 一般／唯一、多欄位 ASC／DESC                         | 資料表 AFTER／INSTEAD OF；View INSTEAD OF，敘述層級 inserted／deleted 集合                           |

## 工作流程

1. 進入對應建立分頁，指定名稱與 Schema。資料表使用欄位表單（沿用依引擎區分的型別自動完成、長度／精度與小數位數）；索引依勾選順序建立索引鍵。
2. View 輸入 SELECT 定義，並依引擎設定演算法、定義者、安全性與檢查選項；Trigger 選目標、事件與時機，再輸入內容。SQL 內容引用其他物件時，建議明確寫出 Schema；切換表單 Schema 不會重寫自訂 SQL 的引用。
3. 按「預覽 SQL」。只有完成預覽且未再修改表單時才能按「建立物件」。預覽會讀取 metadata 並驗證表單，不會執行 DDL；完整 SQL 語意由伺服器在建立時驗證。
4. 建立成功自動刷新瀏覽器，可按「開啟已建立物件」進入資料表／View 或索引／Trigger 定義分頁。失敗保留輸入與錯誤訊息，既有物件不覆寫。

草稿保存於工作區，重新載入後保留；未儲存草稿受關閉與中斷連線確認保護。建立使用共用 Command Bus 的 `ddl` 權限、核准與 audit。SQLite／PostgreSQL／SQL Server 使用交易；MySQL／MariaDB DDL 隱式提交。PostgreSQL 同時建立函式與 Trigger 時，其中任一步失敗會一起回滾，不使用 CREATE OR REPLACE。

## 本輪界線

表單提供常用物件建立；索引可設定引擎支援的類型、方法與註解，MySQL／MariaDB 包含 FULLTEXT／SPATIAL，PostgreSQL 方法由 pg_am 讀取。尚不包含 SQL Server 特殊索引、部分索引條件、indexed/materialized view、事件／DDL Trigger、identity/sequence、外鍵與儲存參數的完整建立表單；這些進階選項可使用 SQL 查詢分頁。Trigger body 僅填 SQL 內容，不帶外層 BEGIN/END、GO 或 DELIMITER；初始內容是可修改範例。PostgreSQL 的函式需回傳 NEW（INSERT／UPDATE）或 OLD（DELETE）。

Table 建立表單另提供產生欄位設定，依引擎顯示 Virtual／Stored 與產生運算式。SQL Server 的計算欄位由運算式決定型別，其他引擎沿用型別編輯器。啟用時清除不相容的預設值／主鍵設定，可空值由引擎決定；運算式由共享命令驗證，不能附加其他 SQL 敘述。詳細版本差異見 README「產生欄位」。

驗證命令：`npm test`、`npm run test:integration`、`npm run build`、`node scripts/smoke-create-objects.mjs`。真實建立測試涵蓋 SQLite、PostgreSQL、MySQL、MariaDB、SQL Server，包括 Trigger 實際生效、名稱碰撞、唯讀 agent 拒絕 DDL、預覽不寫入、PostgreSQL 函式回滾。

官方參考：[MySQL CREATE TRIGGER](https://dev.mysql.com/doc/refman/8.4/en/create-trigger.html)、[MariaDB CREATE TRIGGER](https://mariadb.com/docs/server/server-usage/triggers-events/triggers/create-trigger)、[SQLite CREATE TRIGGER](https://www.sqlite.org/lang_createtrigger.html)、[PostgreSQL CREATE TRIGGER](https://www.postgresql.org/docs/17/sql-createtrigger.html)、[SQL Server CREATE TRIGGER](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-trigger-transact-sql)。
