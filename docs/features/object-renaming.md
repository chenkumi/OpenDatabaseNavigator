# SQL 物件重新命名

資料庫瀏覽器的 Table／View／Index／Trigger 右鍵或「⋯」選單新增「重新命名」。輸入新名稱後先預覽 SQL，再套用。

## 引擎行為

| 引擎                 | Table                                           | View                                                           | Index                                  | Trigger                                                              |
| -------------------- | ----------------------------------------------- | -------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| SQLite               | ALTER TABLE RENAME；SQLite 更新受支援的相依定義 | 交易內重建；保留所屬 INSTEAD OF triggers；其他相依引用須先處理 | 交易內重建，保留條件／expression／排序 | 交易內重建，保留完整 body                                            |
| PostgreSQL           | ALTER TABLE RENAME                              | ALTER VIEW RENAME                                              | ALTER INDEX RENAME                     | ALTER TRIGGER … ON … RENAME；函式保留                                |
| MySQL／MariaDB       | RENAME TABLE                                    | RENAME TABLE                                                   | ALTER TABLE RENAME INDEX               | DROP／CREATE；保留 definer、SQL mode、字元集及觸發順序，失敗嘗試還原 |
| SQL Server           | sp_rename OBJECT                                | sp_rename OBJECT                                               | sp_rename INDEX                        | sp_rename OBJECT                                                     |
| SAP／Sybase ASE 16.x | sp_rename                                       | sp_rename                                                      | sp_rename … index                      | sp_rename                                                            |

ASE 仍是實驗性支援，沒有真實 ASE 伺服器驗證。Redis 使用既有鍵操作，不提供 SQL 物件改名。

## 保護與限制

- 只改名、不移動 database／schema；目前拒絕僅變更大小寫。新名稱上限沿用介面 128 字元，另檢查 PostgreSQL 63 bytes、MySQL 64 字元及 ASE 的 bytes 限制。名稱一律依引擎引用，不能當成另一段 SQL 執行。
- 預覽檢查名稱衝突及來源定義；套用重新查詢版本、重名與未儲存狀態。SQLite 重建移除來源 `IF NOT EXISTS`，避免競爭下跳過建立新物件卻刪除原物件。
- 相關資料／結構／Index／Trigger 分頁尚有變更時拒絕改名，不提供直接丟棄的捷徑。成功後保留分頁位置、更新名稱和路徑，重新載入乾淨分頁；其他連線／database 與查詢文字不變。DDL 執行中才產生的草稿會保留於原分頁，不會丟棄。
- 使用 `object.rename_preview`／`object.rename` 共用命令、DDL 權限、核准與 audit。唯讀 agent 不能改名；完整表單、目標與版本受既有核准規則保護。
- SQL Server／ASE 原始 module 定義可能保留舊名稱。讀取 View／Trigger 時按 catalog 的目前名稱修正「宣告 header」，Trigger 的 ON 目標同樣使用目前所屬資料表，確保後續編輯可用。這不會自動修改 body 或其他 SQL 引用。
- 相依 View、routine、查詢及外部應用程式的引用不會全面自動改寫；預覽會提示檢查相依物件。MySQL／MariaDB 的物件專屬 grants 不自動移至新名稱。
- SQLite View／Index 重建前保守檢查儲存定義中的舊名稱引用，不做全域文字替換。相依引用無法確認安全時拒絕；即使是同名 alias／字串也可能觸發保守拒絕。View 重建後會驗證資料庫內 View 可編譯，失敗回滾。SQLite 不承諾多個 trigger 的執行順序。
- MySQL／MariaDB Trigger 改名不是原子操作，存在沒有 trigger 的空窗，失敗會嘗試原定義還原；須安排合適操作時段。連線失聯等不確定結果仍應重新整理確認，不能無條件重送。
- 沿用既有物件讀取限制：系統／約束／不完整定義／特殊索引等物件不強制改名，介面會顯示原因。索引或 View 的重建可能取得鎖。

## 驗證

2026-09-28 驗證結果：型別檢查、建置通過；一般測試 85 通過／29 條件式略過；完整整合測試 36 通過（含 PostgreSQL、MySQL、MariaDB、SQL Server 改名後的 View／Trigger 再編輯）。Electron 改名 smoke 通過，截圖 `.local/rename-object.png` 已檢視。ASE 只有方言測試，沒有真機驗證。

```sh
npm test -- --maxWorkers=2
npm run integration:up
npm run test:integration -- --maxWorkers=2
npm run test:desktop:rename
npm run integration:stop
```

新增測試位於 `tests/rename-objects.test.ts`，包括 SQLite 四類改名、資料與定義保留、INSTEAD OF trigger、相依拒絕、重名、版本、dirty、唯讀 agent、分頁隔離、名稱注入及交易回滾；真實 PostgreSQL／MySQL／MariaDB／SQL Server 測試會建立隨機測試物件，改名後再次編輯 View／Trigger，再清除。

ASE 方言測試加入 `tests/sybase.test.ts`；桌面流程位於 `scripts/smoke-rename-objects.mjs`，使用隔離 SQLite 檔案，驗證四類選單、預覽、dirty／重名錯誤、樹與分頁更新、資料及重新載入保存。

## 官方語法依據

- [SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html)
- [PostgreSQL ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html)、[ALTER VIEW](https://www.postgresql.org/docs/current/sql-alterview.html)、[ALTER INDEX](https://www.postgresql.org/docs/current/sql-alterindex.html)、[ALTER TRIGGER](https://www.postgresql.org/docs/current/sql-altertrigger.html)
- [MySQL RENAME TABLE](https://dev.mysql.com/doc/refman/8.4/en/rename-table.html)、[ALTER TABLE](https://dev.mysql.com/doc/refman/8.0/en/alter-table.html)、[Trigger 操作](https://dev.mysql.com/doc/refman/8.4/en/trigger-syntax.html)
- [SQL Server sp_rename 與 module 名稱限制](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-rename-transact-sql)
- [ASE sp_rename](https://help.sap.com/docs/SAP_ASE/fbeb8a16c28d4140a01bd3b5821e0cd5/ab7a0ecfbc2b1014adff81652c68d4d3.html?version=16.0.2.1)
