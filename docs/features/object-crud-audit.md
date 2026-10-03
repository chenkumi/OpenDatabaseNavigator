# Table／View／Trigger／Index 功能盤點與補齊

## 盤點結果

以四類 SQL 物件 × 新增／修改／刪除計算，共 12 項基本操作。迭代前 8 項已有實作、4 項缺少完整刪除流程。本次補齊 4 項，基本操作達 12／12；這不代表涵蓋各資料庫所有進階 DDL 選項。

| 物件    | 新增（既有）                                  | 修改（既有）                                     | 刪除（本次新增）                             |
| ------- | --------------------------------------------- | ------------------------------------------------ | -------------------------------------------- |
| Table   | 欄位、型別、長度／精度、NULL、預設值、複合 PK | 新增／移除欄位、欄位改名、型別、NULL、預設值、PK | DROP TABLE，揭露所屬索引／觸發器及分頁       |
| View    | SELECT 定義                                   | 完整 CREATE VIEW 定義編輯                        | DROP VIEW                                    |
| Trigger | 時機、事件、目標、主體；PG 新建／既有函式     | 定義編輯，保留引擎相關屬性                       | DROP TRIGGER；PG 指定 ON table，保留共享函式 |
| Index   | 目標欄位、順序、ASC／DESC、UNIQUE             | 索引定義編輯                                     | DROP INDEX；MySQL／SQL Server 指定 ON table  |

## 資料庫與操作入口

SQLite、PostgreSQL、MySQL、MariaDB（使用 MySQL adapter）、SQL Server 的上述基本流程均有對應實作。Redis 沒有這四類 SQL 物件，沿用 key 型別操作。

- 新增：資料庫瀏覽器群組右側 ＋ 或群組右鍵，開啟新增分頁。
- 修改 Table／View：物件右鍵「設計資料表／設計檢視表」。
- 修改 Index／Trigger：物件右鍵「修改定義」或雙擊，開啟定義分頁。
- 刪除：四類物件的右鍵選單，開啟浮動確認視窗，展示目標資料庫／schema、SQL、所屬物件與受影響分頁。
- 成功新增、修改、刪除後更新瀏覽器；刪除只關閉該連線、資料庫、schema 下的相關物件分頁，保留查詢分頁和建立表單。

## 刪除的實作邊界

`object.drop_preview` 為唯讀預覽；`object.drop` 是 destructive 命令，經 Command Bus、既有連線權限和審批處理。SQL 使用引擎識別字引用，不接受任意 DROP 文字。執行前重新讀取定義，比對預覽版本；有髒分頁需明確同意捨棄。執行失敗保留分頁並顯示錯誤。

不使用 CASCADE。表格本身的資料、所屬索引／觸發器會隨刪表移除；外部 view、routine 或查詢的引用不會自動改寫。資料庫拒絕相依性刪除時直接回報；SQLite 在同一交易內檢查剩餘 view 是否仍可準備查詢，失效即回滾。MySQL DDL 為隱含提交，不宣稱交易式回滾。

約束管理、系統產生、分割或特殊索引／觸發器及不完整定義沿用既有唯讀保護，提示透過所屬表格／專用 DDL 管理。表格設計器可管理 PK；不將 constraint-backed index 當普通索引直接刪除。PG trigger function 可能共用，刪除 trigger 不連帶刪除函式。

## 仍屬進階功能範圍

物件本身重新命名、FK／CHECK 設計器、分割表、物化檢視、索引全文／空間等特殊選項並非本次 12 項基本流程的完成標準；建立表單範圍另見 OBJECT_CREATION.md。現有 SQL 編輯器可使用資料庫原生語法處理權限允許的進階 DDL。

## 語法依據

- [PostgreSQL DROP TRIGGER](https://www.postgresql.org/docs/current/sql-droptrigger.html)
- [SQL Server DROP INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/drop-index-transact-sql)
- [SQLite DROP TABLE](https://www.sqlite.org/lang_droptable.html)

## 驗證結果

- 一般測試：63 通過、17 條件式略過。
- 真實資料庫整合：17 通過，含五種 SQL 配置的新增／修改／刪除。
- TypeScript 與 production build 通過。
- Electron smoke：四類右鍵刪除、取消、髒分頁保護與清單更新通過。

測試均使用隔離 SQLite／Docker 測試資料，沒有操作使用者的既有業務資料庫。
