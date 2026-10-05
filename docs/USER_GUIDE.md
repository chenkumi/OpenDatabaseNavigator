# Database Workspace — 使用與開發指南

> 專案簡介與快速開始請見[根目錄 README](../README.md)。本文是詳細的操作、安全限制、測試與驗證說明。

依照 [PLAN.md](architecture/plan.md) 實作的 Electron + React 資料庫桌面應用。GUI 與 MCP 共用同一個 Application Command Bus、權限層、服務與事件匯流排。

支援 SQLite、PostgreSQL、MySQL／MariaDB、SQL Server、Redis、繁中／英文桌面工作區與 Remote MCP。逐項功能與驗證證據列在 [IMPLEMENTATION.md](history/implementation-log.md)。

另提供 **SAP／Sybase ASE 實驗性唯讀接入**：目前以 ASE 11.x 為實測目標，11.5.1.2 已通過基本連線／唯讀查詢；16.x 尚未真機驗證。GUI／MCP 均禁止寫入、DDL、SQL 檔案執行及原生 SQL 匯出。須另外安裝 SAP ASE ODBC 驅動；`npm run test:sybase` 現在僅執行唯讀測試，詳見 [ASE 唯讀支援](engines/sybase-support.md)。

## 開發

新增資料庫引擎前，請參閱 [新增資料庫支援：功能與實作規格](new-database-support.md)，內含必要功能、修改位置、引擎能力表與驗收清單。

使用者介面採用 **shadcn/ui Base UI（base-nova）**、Tailwind v4 與共用明暗主題；元件原始碼位於 `src/renderer/src/components/ui`。畫面盤點、遷移範圍及驗證紀錄見 [UI 重構文件](history/ui-refactor.md)。Monaco 與 TanStack 分別保留 SQL 編輯和大型結果集功能。

需要 Node.js 24+、npm，以及支援 Electron 的作業系統。

Windows 本機驗證目前使用 Node 24.21.0。24.15.0 曾在不同測試檔案發生 worker exit 3221226505，原因尚未確定；24.21.0 的完整一般／資料庫整合測試通過。若遇到相同異常，先記錄 Node 版本與失敗檔案，再用較新的 24 LTS 做對照，詳細證據見 IMPLEMENTATION.md。

```sh
npm install
npm run dev
```

```sh
npm run typecheck
npm test
npm run build
npm start
npm run test:desktop
```

若 Electron 執行檔未下載完成，可執行 `node node_modules/electron/install.js` 安裝。`test:desktop` 使用獨立暫存目錄與真正 Electron／SQLite，截圖儲存在 `.local/desktop-smoke.png`。

`npm run test:desktop:all` 只建置一次，再依序執行所有不需外部服務（Docker 或 Windows）的桌面 smoke；加上 `--all` 會連同整合服務與 Windows 測試一併執行（`node scripts/run-smokes.mjs --all`）。各 smoke 的暫存資料目錄會在腳本結束時自動刪除，除錯時設定 `KEEP_SMOKE_DATA=1` 可保留。整合密碼由 `scripts/support.mjs` 統一讀取：優先使用環境變數 `DB_TEST_PASSWORD`，否則讀取 `.local/integration.env`，兩者都不會被輸出。`npm run test:desktop:all`／`test:packaged` 之外，GitHub Actions 的 `CI` 只執行型別檢查、單元測試與建置；真實資料庫整合測試需手動觸發（`workflow_dispatch`）。`npm test` 會略過所有真實資料庫測試，綠燈不代表資料庫整合已驗證。

## Linux／WSL 執行與安全憑證儲存

### 一次性準備與每個工作階段

WSL 需有 WSLg 或其他可用的顯示服務（`DISPLAY`／Wayland），並安裝 README 所列的 Electron 系統函式庫。Electron 執行檔需另確認已下載；`npm ci` 成功不等於桌面環境已可執行。視窗顯示與 keyring 是不同的前置條件，WSLg 不會自動配置安全儲存。

Linux 保存密碼必須有可用且已解鎖的 Secret Service／KWallet。已有 GNOME／KDE 桌面的使用者應沿用原安全 backend；以下為 Ubuntu 24.04／WSL2＋WSLg 範例。若尚未安裝服務，由使用者在自己的終端**安裝一次**：

```sh
sudo apt-get update
sudo apt-get install gnome-keyring libsecret-1-0 libsecret-tools seahorse
```

每次重新登入／重啟 WSL 後，確認 App 與 keyring 可存取同一個使用者桌面 D-Bus session，且 keyring 已解鎖。已自動啟動並解鎖時不用重複操作：

```sh
gnome-keyring-daemon --start --components=secrets
seahorse
busctl --user list | grep org.freedesktop.secrets
```

在 Seahorse 建立或解鎖預設密碼 keyring，使用**非空的主密碼**。WSL 未經桌面 PAM 登入時可能不會自動解鎖；若無法連上使用者 D-Bus，先修復桌面 session。不要把登入／keyring 密碼提供給 Agent、放入環境變數或寫入專案，也不要以空密碼 keyring 或 `--password-store=basic` 繞過保護。程式拒絕 `basic_text`，沒有明文備援。

### 預設啟動與安全狀態

```sh
npm run check:secure-storage
npm run build      # 初次執行或原始碼變更後
npm start          # 一般啟動，不需額外 backend 參數
# 或開發模式：
npm run dev
# 已打包的 Linux x64 產物：
./release/linux-unpacked/database-workspace
"./release/Database Workspace-0.1.0.AppImage"
```

程式在 Electron ready 前套用共用 backend 選擇策略：明確指定的選擇優先；有可辨識原生桌面識別的 Linux 仍保留 Electron 原生選擇（包含 GNOME／KDE）；只有缺少這類桌面識別且未明確指定的 WSL 預設選 libsecret。Windows／macOS、其他 Linux 的原生策略不變，不需偽造 `XDG_CURRENT_DESKTOP`。選到候選 backend **不代表**服務可用；仍需實際安全儲存檢查。本次 WSL 一般啟動實測為 `backend: gnome_libsecret`、`selectionSource: wsl-libsecret`。

`check:secure-storage` 啟動真正 Electron，使用隔離暫存設定檔與固定、非機密的測試字串，不讀取既有憑證。只有安全 backend 可用且加解密往返成功（`available: true`、`roundtrip: true`）才退出 **0**；不可用、往返失敗或逾時則退出 1。不能只以 D-Bus 名稱存在或安裝成功判定可保存密碼。

Settings 與新增／編輯連線表單提供「安全憑證儲存」狀態，顯示是否可用、backend、選擇來源及「重新檢查」。狀態與檢查錯誤不含密碼；UI 不能精確分辨未安裝、已鎖定或 D-Bus 無法連線。顯示的 Ubuntu 安裝命令**僅供手動執行**，App 不執行 sudo、安裝套件或管理使用者服務。解鎖後按重新檢查；仍不可用或顯示需重新啟動時，重啟 App 再檢查。

安全 backend 不可用時，會拒絕新增／替換密碼並保留既有加密憑證檔案；不阻止 SQLite 或無密碼連線的儲存／使用，已保存密碼能否解密仍取決於原 keyring。正式 IPC 只回傳非機密診斷，不提供讀取密碼的 renderer／MCP 介面。

### 明確指定 backend 僅供排錯

只有確認要使用 GNOME Secret Service 排錯時才使用，不是目前一般 WSL 啟動步驟：

```sh
npm run check:secure-storage -- --password-store=gnome-libsecret
# 僅在確認需要相同 backend 後排錯啟動：
npm start -- --password-store=gnome-libsecret
```

**不要任意切換既有憑證的 backend。** 先確保原 keyring 仍可存取，規劃遷移／重新輸入；不同 backend 不保證能解密既有憑證，程式不會自動遷移。歷史報告中的強制 backend／桌面識別步驟是當時的環境記錄，不是目前日常啟動需求。

### Linux x64 展開應用與 AppImage

```sh
npm run package    # 含 build；electron-builder --dir，保留整個 linux-unpacked
# 使用同一份建置產生 AppImage，不上傳：
npx electron-builder --linux AppImage --x64 --publish never
npm run check:linux-artifacts
# PATH 為位置參數，兩種產物分別完整驗收：
npm run test:packaged:credentials -- release/linux-unpacked/database-workspace
npm run test:packaged:credentials -- "release/Database Workspace-0.1.0.AppImage"
```

本機版本 **0.1.0** 的產物為 `release/linux-unpacked/database-workspace`、`release/Database Workspace-0.1.0.AppImage`，未簽章、未上傳；這些命令不會自動發布或 commit。`check:linux-artifacts` 需要 `unsquashfs`（Ubuntu 的 `squashfs-tools`），核對產品身分、ASAR／資產／SQLite runtime、ELF x64、AppImage runtime／內容與安全 launcher，輸出 `release/linux-artifacts.json`，記錄產物 SHA-256、大小、版本、架構及檢查結果。靜態檢查不代表 GUI 或 keyring 啟動成功，需另執行兩個完整驗收命令。

`build.toolsets.appimage` 固定 **1.0.3**，目前驗證的靜態 runtime 為 **dd6cebe**，**不需安裝主機 `libfuse2`**。這不代表不需 FUSE：原生 AppImage 仍需可存取的 `/dev/fuse` 及 FUSE 掛載能力；Electron 原生 sandbox 需可用的非特權 user namespace，另需 Electron 系統函式庫、顯示服務、可存取的使用者 D-Bus 與已解鎖 keyring。缺少這些條件應修復主機環境，不使用 `--no-sandbox`、`APPIMAGE_EXTRACT_AND_RUN` 或 extract-and-run 備援。

封裝必須保留 `scripts/after-pack.cjs` 安裝的專案安全 AppRun（來源 `scripts/linux-app-run.sh`）；它直接啟動原生 executable，保留 sandbox 與 backend 選擇，不重寫桌面／backend 環境。不要省略 hook 或換回會停用 sandbox 的工具鏈預設 launcher。歷史 FUSE 2 需求紀錄仍保留，但不適用目前這個靜態 runtime 產物。

### 本輪驗收證據與界線

- Linux x64／WSL2＋WSLg：共用 bootstrap、health service、UI、型別檢查與建置通過；展開應用及 AppImage 產製通過，10 項 artifact 檢查與 11 項 packaging 測試通過。
- 上述兩個 `test:packaged:credentials` 命令皆退出 **0**：真實 `gnome_libsecret`／`wsl-libsecret` 選擇、連線表單透過正式 IPC 保存加密密碼（回傳不含密碼）、同一隔離 profile 重啟後由主程序中真正的 `CredentialService.get` 核對成功，只回報布林結果。
- 真實子程序不可達 D-Bus 測試為 unavailable；明確 basic 負向測試拒絕新增／替換密碼，既有憑證檔案不變且 SQLite 可用。負向測試只改隔離子程序，不鎖定 keyring 或變更使用者的服務。
- 一般啟動不帶 debug 參數，確認自身可見視窗後以 `WM_DELETE_WINDOW` 關閉，退出 **0**；另有 24 項原生 launcher 測試及 UI 的 8 種語言／主題／尺寸組合 × 3 種安全狀態。測試的 debug／main probes 僅在隔離驗收程序使用，不新增 production 密碼讀取 IPC。
- **不是全平台宣稱**：本輪未在 Windows、macOS 或實體 KDE／GNOME 桌面做同等驗收，原生 backend 選擇由策略單元測試保護。既有 Windows 歷史與[先前 macOS arm64 驗收](../report/REPORT-2026-10-03T04-40-41-726Z.md)是獨立紀錄。其他 Linux／架構、正式簽章／公證發布仍待目標環境驗收。143 項真實外部資料庫測試本輪**略過，不是通過**。

WSL 的 renderer 建置可能需要數分鐘，不要僅因短時間沒有新輸出就判定失敗。一般測試可用 `npm test -- --maxWorkers=2` 降低並行負載；不可藉提高逾時、略過測試來掩蓋已重現的錯誤。SQLite 一般查詢現在使用獨立子程序，取消／逾時會終止原生呼叫，等待退出再開新 session，避免舊呼叫持續持有檔案鎖。取消不會撤銷先前已提交的操作，且記憶體資料庫在 session 被終止後會遺失。

`test:desktop` 在 WSL 顯示隔離測試視窗，確保真實滑鼠拖曳有 compositor frame；其他平台仍維持原有隱藏視窗流程。下拉選項 smoke 使用真實鍵盤選取，沒有強制 click 或略過行為驗證。

## Windows 發行包

```sh
npm run package
npm run test:packaged
```

啟動整合測試 Redis 後，可用 `node scripts/smoke-packaged.mjs --agent` 驗證發行包的 MCP／Redis／核准與桌面取消流程。

啟動 `release/win-unpacked/Database Workspace.exe`。散布時需保留整個 `win-unpacked` 資料夾。此 Windows 包未使用發行者憑證簽章；本節保留既有 Windows 驗證紀錄。另有 macOS arm64 歷史紀錄與本輪 Linux x64／WSL 驗收，範圍與限制見上節及 README，不代表本輪重測了 Windows／macOS。

本次 SQL Server 雙驗證方式的已測試新版位於 `release/sqlserver-auth/win-unpacked/Database Workspace.exe`（舊版執行中，因此另存目錄）。原生驅動使用套件附帶的 N-API 預編譯檔，封裝設定停用重編譯並將驅動放在 ASAR 外。

## 目前可操作的流程

工作區分頁**不會**跨重新啟動保留：結束程式時（以及啟動時）會清空分頁；連線設定、查詢紀錄與稽核紀錄仍會保留。連線短暫中斷時，已開啟的分頁會保持原狀並顯示提示，未儲存的編輯不會遺失。查詢紀錄中的「重新執行」遇到非讀取類語句會先要求確認。

介面採用石墨色深色主題、藍色操作按鈕與緊湊分頁。新設定檔預設深色，既有主題設定保留；可在設定中選擇淺色或跟隨系統。左側連線清單與資料庫瀏覽器分欄，瀏覽器顯示目前所選連線的 database／schema／資料表，並提供資料表名稱搜尋。

原生 File／檔案選單提供新增連線、設定、最小化與關閉；Edit／View 保留標準操作，移除 Window 選單。關閉視窗仍會檢查未儲存資料。主畫面頂部右側放置查詢紀錄、Agent 活動與設定；左側搜尋連線，右側 Tabs 與新增查詢按鈕緊接工具列。設定對話框只有中間內容可捲動，標題與取消／儲存按鈕固定，支援 Tab 焦點循環與 Escape 關閉。

1. 新增 SQLite 檔案連線，或填入 PostgreSQL、MySQL／MariaDB、SQL Server、Redis 的連線資訊。
2. App 啟動時所有連線為灰燈，單擊只選取，雙擊連線名稱（或按 Enter）才建立連線；連線中為黃燈、成功後為綠燈並顯示資料庫列表。雙擊 table 開啟 Data／Structure。
3. 開啟 SQL query，使用 Run SQL 或 Ctrl／Cmd + Enter 執行選取內容。
4. 有 primary key 的資料表可直接編輯儲存格並 Save changes；可新增和刪除資料。數字與布林值保留型別，可用儲存格旁的 ∅ 設定 NULL；再次點擊文字欄位的 ∅ 可設為空字串。
5. 在 Settings 設定每頁筆數、查詢逾時、編輯器及 Agent policy。
6. Redis 連線後，資料庫瀏覽器列出 DB 0～15（依伺服器設定調整）與各庫 key 數量。點選資料庫開啟獨立分頁，可用 pattern 掃描 keys，查看與編輯 String／Hash／List／Set／Sorted Set／Stream／JSON，設定 TTL。各分頁讀寫固定使用自己的 DB，重複點選會回到既有分頁。

連線選單的「中斷連線」會取消該連線的執行中查詢、關閉所有 database scope 的連線，清空對應瀏覽器並關閉該連線的所有分頁；其他連線不受影響。有未儲存修改時先確認是否捨棄，取消則保持連線及分頁。中斷後的背景請求不能自動重連，必須雙擊或選擇「建立連線」。App 冷啟動仍保留已儲存的分頁草稿，但以離線提示代替內容，不會因還原分頁自動連線。MCP 的主動資料操作仍沿用共用服務與權限；明確中斷後需先呼叫 `connection.connect`。

連線生命週期桌面測試：`node scripts/smoke-connections.mjs`（先執行 `npm run build`）。

資料存於 Electron `userData` 目錄。密碼使用 Electron `safeStorage` 加密；系統安全儲存不可用時拒絕儲存密碼。測試可使用 `DATABASE_WORKSPACE_DATA_DIR` 指定隔離資料目錄。

SQL 文字自動儲存，已知憑證與常見密碼語法會在持久化時遮罩。資料表與 Redis 的尚未儲存修改有 dirty 提示及關閉／切換確認。資料表的 Save changes 逐列提交；若中途失敗，已成功的列保留已提交狀態，其餘修改留在畫面供修正重試，並非跨列原子交易。

修改連線名稱、顏色或群組會保留連線與編輯草稿。變更主機、驗證資訊或預設資料庫，以及刪除連線時，會先確認未儲存分頁；確認捨棄後取消執行中的查詢並關閉相關分頁，其他連線的分頁不受影響。表格重新整理期間停用編輯，儲存使用開始編輯時的原始主鍵；原始列已刪除時回報衝突並保留草稿。

Redis Set 的「複製成員」會新增成員，原成員需明確移除；Sorted Set 選取既有成員後編輯分數，使用「新增成員」可建立另一個成員。Agent 寫入目前頁面的資料時，乾淨頁面自動更新，有草稿時保留草稿並顯示提示。

## 匯出 SQL 檔案

SQLite、MySQL／MariaDB、PostgreSQL、SQL Server 資料庫的右鍵／「⋯」選單提供「匯出 SQL 檔案」。勾選「包含資料表資料」匯出結構和資料；取消勾選則只匯出結構。完成後按「儲存 SQL 檔案」選擇目的地，再透過「執行 SQL 檔案」還原到空白資料庫。

- 匯出資料表、索引、檢視及觸發器的原生 DDL。資料使用同一份唯讀快照，保留 64 位整數、BLOB、含 NUL 的文字、UTF-8／UTF-16、rowid、自動編號高水位及資料庫 user_version／application_id。產生欄位由 DDL 重建，不將計算結果誤當可寫欄位；觸發器在資料還原完成後才建立。
- MySQL／MariaDB 使用 SHOW CREATE 保留 Table／Index／View／Trigger 及函式／預存程序；保留 DEFINER、SQL_MODE、定序、AUTO_INCREMENT，排序檢視相依及同表觸發器順序。資料在伺服器端序列化，保留精確數字、BIT／BLOB、ENUM／SET、JSON、空間值、時間精度與各欄字元集；跳過不可寫入的產生欄位。InnoDB 使用 REPEATABLE READ 快照；混合 MyISAM／Aria／MEMORY／CSV／ARCHIVE 使用 READ 鎖，期間會暫時阻擋寫入，需要 LOCK TABLES 權限。取消／完成時釋放鎖與專屬連線，結束前另檢查 live catalog 是否變更。
- MySQL／MariaDB 需在相同產品／相容版本、原名稱與定序相同的空白資料庫還原；不改寫原本的資料庫參照／DEFINER，因此外部相依及定義者帳號必須存在並具有所需權限。範圍為帳號可見的資料表、檢視、索引、觸發器、函式及預存程序，不包含 events、使用者授權或全伺服器設定。備份帳號應具有所有目標物件的 SELECT／SHOW VIEW／TRIGGER／routine metadata 權限。
- SQL 檔案匯入／匯出使用專屬 UTF-8 MySQL session；一般資料查詢仍依連線設定的 charset。避免把 UTF-8 檔案中的 Unicode 文字經過 latin1 等連線編碼替換。
- PostgreSQL 使用原生 `pg_dump` 一致性快照，包含 schema、型別／domain、序號、自訂函式、分割表、產生欄位、索引、約束、View／Materialized View、Trigger、ACL／RLS 及大型物件；依原生工具處理相依與資料還原順序。輸出 UTF-8 INSERT SQL，可由 App 的 SQL 檔案執行還原。純結構模式不包含資料／序號當前值。Windows 原生工具的換行轉換會還原後再儲存，避免改變文字欄位內的 LF／CRLF。
- PostgreSQL 需另有 PostgreSQL 用戶端工具：優先尋找 PATH，之後尋找標準 PostgreSQL 安裝目錄；也可在連線表單指定 `pg_dump` 絕對路徑。建議使用與伺服器相同主要版本的最新修正版工具，原生工具會拒絕過新的伺服器；較新版工具產生的 SQL 不保證能還原到較舊伺服器。程式不會下載工具，也不透過 shell 執行；密碼只透過子程序環境傳遞，不寫進命令列或 SQL 檔。
- PostgreSQL 還原帳號須具有 DDL、OWNER／ACL 等所需權限，參照的角色、擴充套件、資料表空間與外部相依必須存在。角色本身、資料庫建立／預設屬性及全伺服器設定不包含在匯出；明確排除 publication／subscription，foreign table 依原生預設只有定義，沒有遠端資料。Materialized View 依原生方式重新整理，序號亦依原生備份語義處理，不宣稱所有非交易物件都與資料快照完全同步。啟用 TLS 時使用 libpq `verify-full`，須具備 libpq 所需的信任憑證；不會因 Node 連線成功而略過原生憑證驗證。
- SQL Server 2017+ 使用 PowerShell 的 Microsoft SMO 產生原生結構 SQL；資料在伺服器端轉成 SQL literal，避免 JS 數值精度及用戶端字碼頁轉換。支援 SQL 帳密及 Windows 身分，保留高精度 NUMERIC／DECIMAL、二進位、Unicode／NUL／換行、各欄 VARCHAR／TEXT 字碼頁、空間值、hierarchyid、XML、時間精度與 SQL_VARIANT 型別。計算欄位與 rowversion 由目的資料庫重新產生；資料之後才建立外鍵／CHECK／Trigger，保留停用 CHECK、identity 下一值及 sequence 使用位置。序號狀態獨立擷取，不保證與資料列完全同時。
- SQL Server 需另安裝 PowerShell 與該 PowerShell 主機可載入的 `SqlServer` 模組；Windows 也接受既有 SQLPS。Windows 預設使用系統 Windows PowerShell 5.1，其他平台從 PATH 尋找 pwsh；可在連線表單指定絕對路徑。SMO 版本須支援來源伺服器，程式不自動安裝工具。密碼只從 stdin 傳遞，不寫入命令列／檔案；TLS 使用原生 SqlClient 憑證驗證，不忽略憑證錯誤。
- SQL Server 資料匯出在全部使用者資料表持有共享鎖，完成／失敗／取消時釋放，期間會阻擋寫入。需要資料庫 VIEW DEFINITION 及所有目標資料的 SELECT 權限；有遮罩欄位時另需資料庫 UNMASK。啟用 RLS、Always Encrypted、temporal／ledger 資料目前明確拒絕資料模式，可改匯出結構；其他無法鎖定／序列化的特殊資料表也不輸出半成品。匯出期間應停止 DDL，程式會檢查 sys.objects 變更，但不將此檢查視為所有 metadata 的交易快照。
- SQL Server 請還原到相容版本、原定序相同的空白資料庫，先備妥參照的帳號／角色、filegroup、CLR assembly 等外部相依；不包含 CREATE DATABASE、資料庫預設設定、使用者／角色建立或全伺服器物件。原生結構包含 schema、型別、序號、分割配置、Table／Index／View／Trigger、函式／預存程序、synonym、full-text 與 security policy，以及物件授權／註解。未具備外部相依時，匯入會回報失敗；這不是完整伺服器備份替代品。
- 顯示匯出大小、資料表／資料列數與進度，可取消。PostgreSQL 原生工具未提供資料列計數，以「—」表示；查詢逾時作為等待工具輸出的閒置期限，取消／逾時會終止工具並等待其結束。沿用 SQL 檔案匯入的 16 MiB 與 50000 批次上限。SQLite 虛擬／shadow table、所有 rowid 別名均被遮蔽的資料表，以及 MariaDB sequences／system-versioned tables、遠端／特殊儲存引擎目前會明確拒絕；ASE 的原生 SQL 匯出已停用。超出伺服器 max_allowed_packet 造成值序列化失敗時亦拒絕，不將原資料誤寫為 NULL。
- 成功前只寫入應用程式產生的暫存檔；失敗／取消不開放儲存。儲存以目的目錄暫存檔完成後替換，不直接覆寫未完成的檔案，並拒絕覆蓋已設定的 SQLite 資料庫檔。關閉視窗／應用程式清除匯出暫存檔。
- MCP 使用 `export.manage` 的 `start`、`status`、`read`、`cancel`、`release` actions，委派至共用匯出命令。`read` 以 byte offset 分批回傳最多 64 KiB 的 base64；沒有任意本機檔案讀寫參數。Agent 只能讀取自己建立的匯出，且每次檢查目前連線權限／設定。完成後應呼叫 `release`；最多同時 4 個工作、保留 12 個匯出。

桌面驗證：`npm run test:desktop:sql-export`；啟動整合服務後可執行 `npm run test:desktop:mysql-export`、`npm run test:desktop:postgres-export`、`npm run test:desktop:sqlserver-export`。SQLite 資料往返與權限測試：`npm test -- --maxWorkers=1 --no-isolate tests/sql-export.test.ts`；MySQL／MariaDB／PostgreSQL／SQL Server 已納入 `npm run test:integration`。PostgreSQL 測試需在主機安裝 `pg_dump`；已驗證 Windows pg_dump 18.0 對 PostgreSQL 17.11。SQL Server 需上述 PowerShell 模組，已驗證 SQLPS／SMO 16 對 SQL Server 2022；Windows 身分測試另設 `TEST_WINDOWS_SQLSERVER=1`，依下節本機環境執行。其他版本仍受原生相容性限制。

ASE 一律唯讀，結構／資料的原生 SQL 匯出均停用；不啟動 DDLGen／JDBC 匯出工具，也不對資料表取匯出鎖。已取得查詢結果的 CSV／JSON 匯出仍可使用，詳見 [ASE 唯讀支援](engines/sybase-support.md)。

## 真實資料庫整合測試

### SQL Server 驗證方式

新增伺服器連線時，資料庫欄位可留空，連線後再從資料庫瀏覽器選擇。MySQL 不預選資料庫，PostgreSQL 使用 `postgres`、SQL Server 使用 `master` 建立初始連線，Redis 使用 DB 0；若帳號無權連入這些預設資料庫，可填入有權限的資料庫名稱。SQLite 仍須指定資料庫檔案。

新增或編輯 SQL Server 連線時，可選擇「SQL Server 驗證」（帳號／密碼），或僅在 Windows 提供的「Windows 驗證」。既有連線預設維持 SQL Server 驗證。

Windows 驗證使用執行應用程式的目前 Windows 身分，電腦需安裝 Microsoft ODBC Driver 18 for SQL Server，且該身分須有目標 SQL Server 的存取權。此模式不需輸入帳號密碼；切換並儲存後會移除原本儲存的 SQL 密碼。主機可填一般伺服器名稱、`server\instance`，或本機共用記憶體連線 `lpc:localhost`；後兩者不使用表單的連接埠。

SQL 帳密模式的 DECIMAL／NUMERIC（含 SQL_VARIANT 內的小數）以精確字串回傳，支援 38 位精度；Tedious 解碼相容層固定為 20.0.0，升級前須驗證封包與真實伺服器測試。Windows 驗證的 NUMERIC 亦保留字串，但目前 msnodesqlv8 原生驅動對 DECIMAL 仍先轉 double，無法無損還原。因此含 DECIMAL 或 SQL_VARIANT 的結果會明確拒絕，請將結果欄位在 SQL Server 端轉成 `NVARCHAR(50)`，或改用 SQL 帳密連線；此限制也會影響包含這些欄位的資料表瀏覽。收到結果型別錯誤不代表 SQL 未執行，不應直接重試寫入。

Windows 實機驗證使用本機 SQL Server（預設 `lpc:localhost`，可透過 `WINDOWS_SQLSERVER_HOST` 修改）：

```powershell
$env:TEST_WINDOWS_SQLSERVER='1'
npm test
```

啟動下方 Docker 整合測試服務後，可執行 `npm run test:desktop:sqlserver-auth`，同時驗證 Windows 身分與 SQL 帳密登入、表單切換和設定保存。封裝後可用 `node scripts/smoke-sqlserver-auth.mjs --packaged` 驗證相同流程。

### Docker 測試服務

安裝並啟動 Docker Desktop 後：

```sh
npm run integration:up
npm run test:integration
npm run test:desktop:agent
npm run test:desktop:scopes
npm run integration:stop
```

測試服務僅綁定 127.0.0.1，使用 PostgreSQL 15432、MySQL 13306、MariaDB 13307、SQL Server 11433、Redis 7.4 16379、Redis 8.2（原生 JSON 測試）16380。隨機密碼保存在已排除版控的 `.local/integration.env`。首次啟動需等待映像下載與資料庫初始化；測試會使用隨機資料表／key 並清理自己的資料。SQL Server 映像使用 Developer edition。`integration:stop` 停止服務並保留測試 volume。

SQL Server 原生匯出讀寫期限測試需較新的 SqlServer PowerShell 模組。本機驗證使用 22.4.5.1，可只下載到工作區，不更動使用者模組安裝：

```powershell
Save-Module -Name SqlServer -RequiredVersion 22.4.5.1 -Repository PSGallery -Path .local/powershell-modules -Force -AcceptLicense
```

整合測試 runner 與 SQL Server 匯出桌面 smoke 會將此目錄加入其子程序的 PSModulePath。正式 App 仍使用使用者正常的 PowerShell 模組設定；可透過 `Install-Module -Name SqlServer -Scope CurrentUser` 安裝所需模組。

## 索引進階選項

新增 Index 與既有索引分頁皆提供「索引選項」，可設定類型、方法及原生註解。選項依資料庫和目標資料表顯示，變更先預覽 SQL，再套用。

| 引擎           | 類型／方法                                                                                                             | 註解                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| SQLite         | NORMAL／UNIQUE；BTREE                                                                                                  | 無原生索引註解                           |
| MySQL／MariaDB | NORMAL／UNIQUE；InnoDB、MyISAM、Aria 另提供 FULLTEXT／SPATIAL。一般索引使用 BTREE，MEMORY 可選 HASH                    | COMMENT，最多 1024 字元                  |
| PostgreSQL     | NORMAL／UNIQUE；從伺服器 pg_am 讀取 btree、hash、gin、gist、spgist、brin 及已安裝的方法，按 can_unique／can_order 驗證 | COMMENT ON INDEX                         |
| SQL Server     | NORMAL／UNIQUE；NONCLUSTERED／CLUSTERED rowstore                                                                       | MS_Description 擴充屬性，最多 7500 bytes |
| ASE            | NORMAL／UNIQUE；NONCLUSTERED／CLUSTERED，仍為實驗性支援                                                                | 不提供原生索引註解                       |

方法無排序能力時，建立語法不附加 ASC；明確指定 DESC 會要求修正。資料型別、operator class、INCLUDE、條件索引與相依約束仍由伺服器驗證。方法修改保留原有宣告，不擅自移除不相容的條件或欄位。

PG／SQL Server 僅修改註解時不重建索引。PG／SQLite 在交易內重建；MySQL 使用單一 ALTER TABLE；SQL Server 通常使用 DROP_EXISTING，從 CLUSTERED 轉為 NONCLUSTERED 則於同一交易內 DROP／CREATE，之後恢復註解。含自訂擴充屬性（非 MS_Description）的 SQL Server 索引目前顯示唯讀原因，以免重建遺失屬性；主鍵、約束、分割與特殊索引沿用既有限制。

SQL 與屬性表單使用同一草稿，需先套用或還原才能切換編輯方式。GUI／MCP 共用 object.preview／apply 與版本、權限及稽核。`npm run test:desktop:index-options` 驗證桌面操作；`tests/index-options.test.ts` 驗證實際索引及失敗保留。

## 檢視進階選項

新增 View 與既有 View 的「結構」頁皆提供「檢視選項」，設定經過 SQL 預覽後才執行：

| 引擎            | 表單選項                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| MySQL／MariaDB  | ALGORITHM：UNDEFINED／MERGE／TEMPTABLE；DEFINER：目前帳號或明確帳號與主機；SQL SECURITY：DEFINER／INVOKER；CHECK OPTION：NONE／LOCAL／CASCADED |
| PostgreSQL      | CHECK OPTION：NONE／LOCAL／CASCADED；15+ 另提供 INVOKER／DEFINER（security_invoker）                                                           |
| SQL Server／ASE | CHECK OPTION：NONE／CASCADED，對應無檢查／WITH CHECK OPTION                                                                                    |
| SQLite／Redis   | 不適用                                                                                                                                         |

既有選項會讀回表單；修改與原始 SQL 編輯共用草稿、版本檢查及 DDL 權限。先套用或還原待處理變更，再切換兩種編輯方式。PostgreSQL 使用 ALTER VIEW SET／RESET 保留其他 reloptions、註解與授權；MySQL 明確保留原定義者及未改動設定。檢視能否更新、定義者是否存在與是否有足夠權限，仍由資料庫決定；TEMPTABLE 不能搭配 CHECK OPTION。SQL Server indexed view 沿用唯讀保護；ASE 尚無真實服務驗證。

啟動整合服務後可執行 `npm run test:desktop:view-options` 驗證建立／修改、草稿恢復、錯誤提示與繁中介面；`tests/view-options.test.ts` 驗證 metadata 讀回及 CHECK OPTION 寫入約束。

## 可調整欄寬

主框架採用 [shadcn Base Resizable](https://ui.shadcn.com/docs/components/base/resizable) 的 PanelGroup／Panel／Handle 結構（底層 `react-resizable-panels`），以既有 CSS 主題套用樣式。拖曳兩條分隔線可調整連線清單、資料庫瀏覽器與工作區寬度；分隔線可取得鍵盤焦點並用方向鍵調整。各欄保留最小寬度，避免內容被完全壓縮。

## 資料庫瀏覽器與新增資料庫

連線後以 database → Table／View／Index／Trigger → 物件的樹狀層級瀏覽，資料表可再展開 column。每個 database 的 Query 節點會開啟該資料庫的空白 SQL 分頁，不會直接執行 SQL。Index／Trigger 分類在展開時載入清單；與 Table／View 一樣，雙擊物件會開啟獨立的定義編輯分頁，顯示所屬資料庫、schema、資料表與完整可編輯 SQL。可先預覽實際 DDL 再套用，或還原草稿；受約束管理、特殊類型或無法取得完整定義的物件會顯示不可編輯原因。樹狀清單不再展開詳細內容。分頁支援切換、關閉、重新載入後還原及重新整理；物件已刪除或不可存取時會顯示提示。資料庫下直接依物件類型分組，不再顯示重複的 schema 層或下拉選單；多 schema 的物件使用 `schema.名稱` 區分，開啟時保留正確 schema。點選資料庫或開啟物件會設定新查詢的範圍；既有分頁保留原範圍。展開資料庫時載入內容，可用重新整理按鈕更新清單。

瀏覽器標題列的「＋」可新增資料庫。PostgreSQL、MySQL／MariaDB、SQL Server 輸入名稱後可建立，需要目前連線帳號具有建立資料庫權限；建立成功後重新載入清單並選取新資料庫。SQLite 導向新增連線表單，指定新的檔案路徑後連線即可建立檔案；Redis 資料庫數量由伺服器設定。Redis 列表透過 CONFIG GET databases 與 INFO keyspace 取得資料；權限不足時提示使用推定列表，未知 key 數顯示「—」。本程式新增／刪除 key 後自動更新數量，外部變更或 key 到期可按重新整理更新。每條 Redis 連線最多同時開啟 128 個 DB；中斷連線會一併釋放。

GUI 與 MCP 共用 `database.create` 命令，Agent 遵循連線寫入權限、DDL policy 與核准流程。名稱採引擎對應的識別字引號與長度檢查；重名或權限不足會保留表單並顯示伺服器錯誤。

新增資料庫時，MySQL／MariaDB 可選字元集與定序，SQL Server 可選定序。選項透過共用 `database.options` 從目前伺服器取得；MySQL 定序依字元集篩選，切換字元集會清除先前定序。定序可搜尋，大量選項只顯示前 200 筆符合結果，輸入文字即可縮小範圍。未指定的項目使用伺服器／所選字元集的預設值；如果只指定定序，MySQL 由定序決定字元集。後端再次驗證選項與組合，不接受跨引擎無效設定。

PostgreSQL 新建資料庫可選 encoding、locale、LC_CTYPE；15+ 可指定 libc／ICU（伺服器需提供 ICU），17+ 可指定 builtin。Locale 提供伺服器 catalog 建議，也可輸入伺服器作業系統／ICU 支援的名稱；builtin 使用支援清單，ICU 需 UTF8。指定編碼／locale 時從 template0 建立，以免 template1 的預設值阻止其他編碼。既有 PostgreSQL 資料庫的編碼與 locale 不能原地修改。

在資料庫名稱上按右鍵或點選 ⋯ →「資料庫屬性」，可查看目前設定。MySQL／MariaDB 可修改預設字元集與定序；SQL Server 使用者資料庫可修改定序；PostgreSQL、SQLite 與 ASE 顯示唯讀能力及原因。修改先預覽 SQL 再套用，使用共用 destructive 權限及版本檢查；新預設值不會自動轉換既有欄位。SQL Server 套用時會等候本程式已送出的查詢完成、釋放該資料庫的連線池，之後可重新開啟；不強制中斷其他用戶端或刪除相依物件，伺服器拒絕時保留原設定。系統資料庫定序須依伺服器管理流程調整，此處不提供修改。

`npm run test:desktop:database-properties` 驗證屬性入口、預覽／套用、PostgreSQL locale 建庫與繁中畫面；`tests/database-properties.test.ts` 驗證實際建立／修改、資料保留、版本衝突、權限及 SQL Server 名稱衝突失敗後可重連。

## 執行 SQL 檔案

在資料庫名稱上按右鍵或點選 ⋯ →「執行 SQL 檔案」，選取 `.sql`，檢查行號與批次預覽後按「執行檔案」。預設遇到第一個錯誤即停止，也可事先勾選「遇到錯誤後繼續」。執行期間顯示完成數、錯誤行號與最近 200 筆結果，並可取消；不會自動重試失敗的寫入。查詢結果集不在這個匯入視窗展開，需使用一般查詢分頁檢視資料。

整份檔案使用獨立、固定的 session，交易、暫存表及 SET 不會分散到不同連線或洩漏到一般分頁。依檔案自身 BEGIN／COMMIT 執行，沒有額外包住整份檔案的交易；已提交操作或隱含提交 DDL 可能無法回滾，關閉 session 會回滾未提交交易。取消／逾時／手動中斷連線會停止後續批次，失去連線後不自動重新執行。SQLite 檔案匯入使用獨立子程序，可中止同步原生查詢並釋放檔案鎖；`:memory:` 資料庫不提供跨程序檔案匯入。

支援 UTF-8（可含 BOM）及含 BOM 的 UTF-16 LE／BE，最多 16 MiB、50000 個敘述／批次。各引擎分段方式：

- MySQL／MariaDB：分號及 `DELIMITER $$`／`//` 等標點分隔符；辨識字串、註解與可執行版本註解。預覽取得 SQL_MODE，執行 session 使用同一模式；支援 SQL_MODE 字串常值、保存／還原 `@@SQL_MODE`。無法可靠推導的動態 SQL_MODE 表達式會在執行前拒絕。
- PostgreSQL：分號、dollar quote、E 字串與 BEGIN ATOMIC。使用 `standard_conforming_strings=on`，反斜線請寫成 E 字串。需要切換此解析模式的檔案會明確拒絕。
- SQL Server／ASE：獨立一行的 `GO`，可含 `--` 註解及 1～1000 次重複次數；同一 batch 內的變數與分號保留。沒有 GO 時整份檔案是一個 batch，是否繼續同批次的 SQL 由伺服器語義決定。ASE 只有模擬驅動驗證。
- SQLite：分號與完整 CREATE TRIGGER 本體，CASE／END 與字串中的分號不會被誤切。

不執行 shell、SOURCE／include、SQLCMD／psql 等用戶端指令；COPY FROM STDIN 的資料串流格式請使用原生工具，或改用 INSERT SQL。這是 SQL 文字檔執行器，不是各原生工具所有 dump 格式的替代品。

GUI／MCP 共用 `script.preview`、`script.execute`、`script.status`、`script.cancel`。本機選檔 `file.sql.open` 僅開放桌面使用者；MCP 傳入 SQL 文字，不取得任意檔案讀取權。Agent 執行需要 destructive 授權，並逐一檢查檔案涉及的其他寫入政策；未知批次要求全部寫入政策，Deny 不能被整份檔案核准繞過。每份檔案記錄摘要、雜湊與完成狀態，最多記錄前 200 筆錯誤片段，避免把大型檔案反覆寫入稽核儲存區。每個連線同時一份、全程式最多四份，近期工作狀態保留 20 份至程式結束。

`npm run test:desktop:sql-file` 使用獨立 SQLite 檔測試選檔讀取、預覽、交易匯入、遇錯繼續、取消及繁中介面，不需 Docker；`tests/sql-script.test.ts` 另涵蓋 MySQL、MariaDB、PostgreSQL、SQL Server 的真實固定 session、程序／trigger、交易、取消與連線生命週期。

語法依據：[MySQL DELIMITER](https://dev.mysql.com/doc/refman/8.0/en/stored-programs-defining.html)、[SQL Server GO](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/sql-server-utilities-statements-go)、[SQLite complete statement](https://sqlite.org/c3ref/complete.html)。

## 連線進階設定

- **Connection timeout**：每個網路連線可設定 100～300000 毫秒，預設 10000。傳入對應驅動的連線逾時；ASE 原生登入逾時取整至秒，另以毫秒計時限制開啟等待時間。這不取代設定中的查詢逾時。
- **Heartbeat interval**：保持連線間隔，以秒為單位，0 停用（預設）；開啟時範圍 1～86400。成功連線後，每個已開啟的 database scope 在前次檢查完成後等待指定間隔再檢查，不重疊執行。SQL 連線池執行唯讀 `SELECT 1`，Redis 使用 `PING`，ASE 使用既有 anchor session；不保證維持連線池中每一條閒置實體連線。SQLite 沒有此選項。
- **用戶端字元集**：MySQL／MariaDB 可輸入例如 `utf8mb4`、`latin1`，留空使用驅動預設。Redis 可選 UTF-8（預設）、Latin-1、Windows-1252、Big5、GBK、GB18030、Shift JIS、EUC-JP，套用於鍵名、值及集合／Stream 欄位；JSON 文件與路徑固定 UTF-8。不能以所選編碼無損表示的文字會在送出前拒絕；讀取不符合編碼的位元組也明確報錯。設定不會轉換既有資料，應選擇資料寫入時使用的編碼。Redis pattern 仍依位元組比對，非 ASCII 字元內的 glob 特殊位元組會自動跳脫。

MySQL／MariaDB、PostgreSQL、Redis 及 SQL Server 另有 **Read timeout／Write timeout**，以毫秒設定，0 停用（舊連線預設），最大 300000。Read timeout 限制等待結果時沒有收到 socket 資料的時間，每次收到資料重設；不是查詢總時間，閒置連線及本機暫停消費結果時不計時。Write timeout 在仍有 socket 寫入待完成時生效，每次寫入 callback 完成表示向底層傳輸有進度；它不表示伺服器已收到全部資料或已提交交易。逾時會銷毀該實體連線並立即回報，不自動重試原 SQL。Query timeout 仍獨立限制整體查詢，Connection timeout 負責登入。

一般查詢／metadata／DDL 與 SQL 檔案使用同一套傳輸處理；MySQL／MariaDB 的 SQL 匯出也適用。PostgreSQL 在實際發出 Query／Parse／Bind 時開始計時，ReadyForQuery 時停止，不把池閒置或尚未發出的排隊查詢算成逾時。TLS 在登入完成後的加密 transport 上套用且保留憑證驗證。

PostgreSQL 原生 pg_dump 匯出也套用連線的讀寫期限，另保留獨立匯出期限。只有啟用 I/O 期限時才建立本機 127.0.0.1 隨機埠轉送層，監測通往資料庫的實體 socket；使用 libpq 的 hostaddr 導向轉送層，保留原 host 供 TLS／驗證使用。資料與 TLS 交握原樣轉送，不解密、不降低 verify-full；工作完成、失敗或取消會關閉轉送層。原生匯出以整個工作（含登入）為作用範圍監測網路無活動時間，不解析各 SQL 的完成訊息；處理本機輸出與下游背壓時暫停讀取期限，工具內部長時間計算而沒有網路往返仍計入無活動時間。

SQL Server 帳密模式涵蓋查詢、DDL／交易與 SQL 檔案，使用登入後的實體網路 socket（TDS 7.x 的 TLS 內部雙工串流不作為 TCP 寫入完成依據）；暫停消費結果時暫停讀取期限。SQL Server 的 TCP 原生匯出也使用轉送層與讀寫期限，仍保留獨立匯出期限。SMO 可能同時開啟數條連線，讀取無活動時間以整個工作共用，任一連線接收資料都重設；寫入期限則逐條 socket 計算。需使用含 Microsoft.Data.SqlClient 5.0 以上版本的 SqlServer PowerShell 模組，以 HostNameInCertificate 保留原始伺服器名稱驗證；舊 SQLPS 只適用未啟用 I/O 期限且未指定 SPN 的匯出。原生匯出期限接受明確 TCP host／port，不接受 named instance、named pipe 或 shared memory。

Redis 的所有工作區命令及 Heartbeat 也套用此期限，TCP／TLS 皆可使用；不重送失敗命令，多個同時要求建立連線的操作共用同一次連線嘗試。Redis 的 Connection timeout 同時涵蓋 TCP／TLS 與 AUTH／SELECT 等初始化等待。

pg_dump 的端點與名稱驗證分工依據：[libpq host／hostaddr](https://www.postgresql.org/docs/17/libpq-connect.html#LIBPQ-PARAMKEYWORDS)、[verify-full](https://www.postgresql.org/docs/17/libpq-ssl.html)。轉送層只綁定 loopback，目標固定為這次匯出的已儲存連線；不記錄資料內容，也不重送失敗命令。

Windows 驗證啟用讀寫期限時，必須填入 TCP 主機、獨立通訊埠及伺服器已登錄的 **Server SPN**（例如 `MSSQLSvc/db.example.com:1433`）。程式不猜測 DNS／網域別名的 SPN。每條 ODBC 實體連線各自使用 loopback 轉送層，`Address` 指定傳輸端點，`ServerSPN` 與 `HostnameInCertificate` 保留驗證對象；TLS 不解密且 `TrustServerCertificate=No`。登入及實際查詢／交易／SQL 檔案批次期間監測，閒置／暫停消費時停止讀取計時，不受其他連線的進度影響。原生匯出使用同一 SPN，需新版 SqlClient；停用期限且未填 SPN 時保留既有 Windows 本機／named instance 路徑。修改 SPN 會關閉舊連線，重新連線後生效。

ODBC 傳輸已以真實 Driver 18、SQL Server 與 SQL 帳密測試（隔離 Windows 身分驗證條件）；本機 Windows 身分的共用記憶體相容性另有驗證。目前測試機未開啟 SQL Server TCP，Windows TCP 的 NTLM／Kerberos 與原生匯出端到端驗證仍待具備環境。可在有權限的測試環境設定 `TEST_WINDOWS_SQLSERVER=1`、`WINDOWS_SQLSERVER_HOST`、`WINDOWS_SQLSERVER_PORT`、`WINDOWS_SQLSERVER_SPN`，執行 `tests/sqlserver-auth.test.ts`／`tests/sqlserver-export.test.ts`（匯出需新版 SqlServer 模組）。

Windows 驗證參數依據：[ODBC Address／ServerSPN／HostnameInCertificate](https://learn.microsoft.com/en-us/sql/connect/odbc/dsn-connection-string-attribute)、[SqlClient Server SPN](https://learn.microsoft.com/en-us/dotnet/api/microsoft.data.sqlclient.sqlconnection.connectionstring?view=sqlclient-dotnet-standard-5.1)。

Redis 底層 socket 透過 Node 的 `net.client.socket` 建立通知辨識，以 AsyncLocalStorage 限定本次連線的非同步範圍；不改寫全域 socket factory。通知訂閱在連線成功／失敗後移除，後續只追蹤取得的實體 socket。此 Node 內建 channel 仍屬 experimental；若執行環境無法唯一辨識 socket 且已啟用 I/O 期限，會關閉連線並明確報錯，不會默默忽略設定。更新 Node／Electron 時應重跑 `redis-io.test.ts` 與連線選項桌面 smoke。

ASE 的 Read／Write Timeout（0 停用）適用於唯讀登入、查詢及 Heartbeat；Write Timeout 限制傳輸寫入，不表示開放資料庫寫入。閒置連線不計读取期限，失敗關閉傳輸且不重送。TLS／期限僅有替身驗證，本輪 ASE 11.5 真機只驗證未啟用網路期限／TLS 的基本查詢；詳見 [ASE 驗證方式](engines/sybase-support.md)。

PostgreSQL 可選 UTF8（預設）、LATIN1、WIN1252、BIG5、GBK、GB18030、SJIS、EUC_JP。主程序在 pg Connection 的協定邊界轉換 SQL、文字參數、欄位名稱、資料、通知與錯誤訊息；二進位參數及驗證訊息不轉碼，TLS 信任檢查與實際 socket 的讀寫期限不變。無法無損轉換的文字會報錯，不替換成問號。伺服器與資料庫必須支援所選編碼的轉換；設定不會修改資料庫或既有資料。SQL Server 的用戶端編碼由 Unicode 與欄位定序決定，沒有對應的連線級選項。ASE ODBC 現在使用 `CharSet=ServerDefault;Language=us_english`，避免向舊版伺服器要求不存在的 Windows locale 字元集。本輪只驗證中文常數往返，不宣稱所有業務資料的編碼相容；JDBC 路徑仍待真實 SAP 驗證。

ASE 連線的「用戶端字元集」預設為「ODBC（伺服器預設編碼）」。選用 JDBC 編碼需 JDK 11+ 與合法取得的 `jconn4.jar`；查詢、目錄、Heartbeat 仍受同一唯讀限制，寫入、DDL、SQL 檔案執行及原生 SQL 匯出不開放。JDBC 字元集驗證與 TLS／期限有替身測試，尚未取得本輪 SAP JDBC 真機證據，詳見 [ASE 唯讀支援](engines/sybase-support.md)。

PostgreSQL 的 pg 相容層固定於已驗證的 8.23.0，升級前須重跑協定與真實資料庫測試。請從連線設定修改編碼並重新連線；SQL 內切換 client_encoding 會關閉該 session 並報錯，收到結果解碼錯誤不代表先前寫入未發生。唯讀查詢以有界 portal 擷取 offset＋limit＋1 列，再等候伺服器完成狀態，避免過早交付錯誤編碼的結果。pg_dump 匯出獨立使用 UTF-8，還原其 SQL 檔案時請選 UTF8 連線。

編碼與訊息格式依據：[PostgreSQL 字元集轉換](https://www.postgresql.org/docs/17/multibyte.html)、[PostgreSQL 協定訊息](https://www.postgresql.org/docs/17/protocol-message-formats.html)。

修改以上設定會遵循既有未儲存工作保護並關閉舊連線，需雙擊重新連線後生效。中斷／刪除連線或結束 App 會清除 Heartbeat 排程；檢查失敗時釋放連線、瀏覽器回到未連線狀態，不自動重連。背景斷線保留工作區草稿供重連後處理，手動中斷仍依原流程關閉相關分頁。

啟動整合服務後，可執行 `npm run test:desktop:connection-options` 驗證桌面設定保存、MySQL／SQL Server 資料庫選項、Redis Big5 中文資料與 Heartbeat；一般 `npm run test:integration` 亦涵蓋 MySQL／MariaDB 的 session charset、新建資料庫實際 metadata、Redis 八種編碼的精確位元組與 JSON UTF-8，以及 PostgreSQL 八種用戶端編碼、參數／SQL 檔案、精確位元組、TLS、編碼切換拒絕與有界讀取。

## 查詢分頁與範圍

MySQL／MariaDB 的每次查詢為獨立操作，不保留跨次執行的 `USE`、`SET`、暫存表或交易狀態；切換資料庫請使用瀏覽器並開啟該範圍的分頁。非唯讀 SQL 結束後會銷毀使用過的 session，避免污染後續操作；不能分次執行 `BEGIN`／DML／`ROLLBACK` 作為同一交易。

Explorer 可選擇 database／schema，並展開資料表欄位。已開啟的 table/query tab 保留自己的 database 範圍，不會隨 Explorer 的選擇一起切換；SQL 內的 schema 名稱遵循資料庫原生規則，需要時請使用完整限定表名。

唯讀查詢回傳 `hasMore` 與 `nextCursor`，Agent 透過 `query.next` 讀取下一頁，GUI 使用 **Next result page**。Cursor 只能使用一次、五分鐘後失效，綁定呼叫者與連線；桌面使用者可以接續 Agent 顯示的結果。每一頁重新執行原查詢並略過先前列數，因此屬於即時資料分頁，不是固定交易快照；請使用 `ORDER BY`，並注意並行資料修改可能影響跨頁結果。所有 SQL adapters 對單次結果套用列數上限與 8 MiB 大小上限。

`query.read` 支援已驗證的 SELECT 與 EXPLAIN。SQL Server 的 EXPLAIN 使用獨立連線產生 XML estimated plan，避免 plan mode 影響其他查詢；其行為依據 [Microsoft SHOWPLAN_XML 文件](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-showplan-xml-transact-sql)。

每次執行限一個 SQL 敘述，可在編輯器選取要執行的敘述。唯讀分類對未知函式採保守策略；需要副作用的 SQL 使用 `query.execute` 並遵循寫入政策。Redis 字串／JSON 文件與單筆 Stream 新增內容上限為 1 MiB，集合回應上限為 8 MiB，掃描 cursor 綁定呼叫者、連線、資料庫編號與鍵型別。Redis MCP 指令可用字串 database 指定 DB，省略時使用連線預設值；redis.databases 可讀取 DB 列表與 key 數量。

## MCP

對外工具按功能合併為 **16 項**，涵蓋原本 80 個操作。每次呼叫以必填 `action` 選擇操作，其他參數保持原命令格式；每個 action 的必要欄位、預設值、長度限制與說明列在 `tools/list` 的 input schema。GUI／MCP 仍共用原本 Command Bus，權限、核准、稽核與工作擁有者檢查不變。

| MCP 工具            | action                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `app.inspect`       | `state`, `tabs`                                                                                                              |
| `app.open`          | `query`, `table`, `redis`, `object`, `create_object`                                                                         |
| `connection.manage` | `list`, `status`, `statuses`, `connect`, `disconnect`                                                                        |
| `catalog.list`      | `databases`, `schemas`, `tables`, `indexes`, `triggers`                                                                      |
| `database.manage`   | `options`, `create`, `describe`, `preview`, `apply`                                                                          |
| `object.inspect`    | `describe`, `index_options`                                                                                                  |
| `object.preview`    | `create`, `drop`, `rename`, `edit`                                                                                           |
| `object.apply`      | `create`, `drop`, `rename`, `edit`                                                                                           |
| `structure.inspect` | `columns`, `describe`, `options`, `view_options`, `generation_options`, `preview`                                            |
| `structure.apply`   | `apply`                                                                                                                      |
| `query.manage`      | `validate`, `read`, `next`, `execute`, `cancel`                                                                              |
| `data.manage`       | `select`, `insert`, `update`, `delete`                                                                                       |
| `script.manage`     | `preview`, `execute`, `status`, `cancel`                                                                                     |
| `export.manage`     | `start`, `status`, `read`, `cancel`, `release`                                                                               |
| `redis.read`        | `databases`, `scan`, `get`, `hgetall`, `lrange`, `smembers`, `zrange`, `xrange`, `ttl`                                       |
| `redis.write`       | `set`, `json_set`, `hset`, `hdelete`, `lset`, `rpush`, `sadd`, `srem`, `zadd`, `zrem`, `xadd`, `xdelete`, `delete`, `expire` |

例如原本的 `query.read` 改為呼叫 `query.manage`：

```json
{
  "name": "query.manage",
  "arguments": {
    "action": "read",
    "connectionId": "<connection-id>",
    "sql": "SELECT * FROM users"
  }
}
```

這是 MCP client 介面變更：不再接受舊工具呼叫；請重新取得工具清單並更新 client。即使工具名稱與原命令相同（例如 `object.preview`、`object.apply`、`structure.apply`），也必須提供 `action`。本文其他章節提到的細部命令名稱是 App 內部命令，可透過此表對應的新工具呼叫。`observe` 模式只公開讀取 actions；混合工具會移除寫入 actions，全為寫入的工具不列出。模式改變後需重新取得清單；伺服器每次呼叫均按目前模式檢查。MCP Resources 的 URI 與內容維持不變。

預設停用、僅允許本機介面。於 Settings → Agent / MCP 啟用並取得 token，再在 MCP client 設定 Streamable HTTP：

```json
{
  "url": "http://127.0.0.1:7799/mcp",
  "headers": { "Authorization": "Bearer <desktop-generated-token>" }
}
```

每個連線另有 Disabled／Read only／Read + Write 權限。Assist 模式的寫入會回傳 `approvalId`，必須由桌面使用者核准原始操作，Agent 無法自行核准。核准只可消耗一次，十分鐘後失效；執行前會重新檢查權限。

桌面可選擇「允許這一次」或「允許 10 分鐘」。後者只限同一 Agent、同一操作與連線：新增（insert）涵蓋同一個資料表；更新、刪除、DDL 與 SQL 必須是**完全相同的參數**（篩選條件、數值或語句），換一個條件就會重新詢問；Redis 的非刪除寫入涵蓋同一個鍵，刪除類（`hdelete`、`srem`、`xdelete` 等）須是相同的成員。授權不會跨過 Deny 或連線唯讀設定；停止 MCP、變更設定，或變更連線的目標／Agent 權限即撤銷（只改名稱、顏色或群組不算）；破壞性操作不提供持續授權。`TTL=0` 會刪除 Redis 鍵，因此遵循 delete 政策。Agent 對 Redis 執行 `set` 時，若該鍵存放的不是字串，會被拒絕，避免以 update 權限變相刪除。

DDL 的十分鐘授權另綁定完整驗證後輸入，包含物件名稱、類型、欄位與定義內容；修改建立表單後須重新核准。

Remote Access 必須提供 TLS certificate／key 與明確 Host allowlist。開啟 Remote 後使用 `https://host:port/mcp`。目前提供 generated bearer token；完整 OAuth 是計畫中的後續功能。

MCP 限每個 IP 每分鐘 120 個請求（未帶有效 token 與帶有效 token 的請求分開計算，本機其他程式的未驗證請求不會占用 Agent 的額度）、32 個 session、30 分鐘閒置期限與 1 MiB request body。同一個 Agent 重複送出相同的待核准請求會合併成一筆，且最多同時有 20 筆待核准。Agent 無法用 `connection.disconnect` 丟棄你尚未儲存的草稿，也無法用 `connection.connect` 解除你手動中斷的連線；Agent 開啟的分頁受 100 個分頁上限限制，而且不能覆蓋你正在編輯的查詢分頁結果。支援 `app://workspace`、`app://connections`、`db://connection/{id}/schema` 與 `db://connection/{id}/table/{schema}/{table}`；schema resource 列出連線預設 database 的各 schema／資料表，其他 database 可透過帶 database 參數的 tools 存取。

## 架構

- `src/main/application`：Command Bus、Event Bus、Connection／Query／Data／Workspace Services。
- `src/main/database`：SQL builder、adapter interface、SQLite worker 及各網路資料庫 adapter。
- `src/main/mcp`：官方 MCP SDK Streamable HTTP、驗證、權限、核准與 audit。
- `src/main/credentials`：OS 加密憑證。
- `src/preload`：只暴露固定 IPC 介面，renderer 不直接存取 Node 或 driver。
- `src/renderer`：React、Monaco、TanStack Table 與虛擬化。

實作參考 [Electron security](https://www.electronjs.org/docs/latest/tutorial/security) 與 [官方 MCP SDK](https://modelcontextprotocol.io/docs/sdk)。

Index／Trigger 分頁驗證：`npm run test:desktop:objects`（使用獨立的 SQLite 測試檔，不需要 Docker）。

## Index / Trigger 定義編輯

Table／View／Index／Trigger 可從資料庫瀏覽器的右鍵／「⋯」選單選擇「重新命名」，預覽 SQL 後套用；會檢查重名、物件版本與未儲存分頁，成功後更新相關分頁與瀏覽器。各引擎實作方式及限制見 [物件重新命名](features/object-renaming.md)。

分頁直接編輯 SQL 定義，提供「還原變更 → 預覽變更 → 套用變更」，保留原始定義供比對。MySQL／MariaDB 索引編輯的是 `SHOW CREATE TABLE` 中的 `KEY` 子句，其餘引擎編輯完整 `CREATE` 定義。名稱、schema、所屬資料表固定；可修改索引欄位、排序、unique、filter／expression 與引擎支援的選項，以及 trigger 事件、條件或 body。

SQLite／PostgreSQL 使用同一 session 的交易重建。SQL Server 使用 `DROP_EXISTING`／`ALTER TRIGGER`，並保留停用狀態及 trigger 的模組選項／觸發順序。MySQL／MariaDB 索引以單一 `ALTER TABLE` 更新；trigger 的 drop/create 無法保證跨敘述原子性，重建期間有空窗，失敗會嘗試還原原定義並回報結果。PostgreSQL trigger 所呼叫的 function 是另一個物件，須另以 SQL 修改。

GUI／MCP 共用 `object.describe`、`object.preview`、`object.apply`，套用遵循既有 DDL 權限、核准與稽核流程。套用前重讀定義並比對版本，偵測已發生的外部變更；這是樂觀檢查，不是跨外部客戶端的排他鎖。草稿及其基準版本會保存，錯誤不清除草稿；重新整理和關閉會確認是否捨棄未套用內容。一般 `query.execute` 的單一敘述限制維持不變，複合 trigger body 由專用編輯服務處理。

各引擎差異、完整限制與官方文件請見 [OBJECT_EDITING.md](features/object-editing.md)。測試：`npm test`、`npm run test:integration`、`npm run test:desktop:objects`。

## Table / View 結構編輯

資料表名稱右鍵 →「設計資料表」直接開啟結構設計器。每列可直接修改名稱、型別（依引擎自動完成）、長度／精度、小數位數及 NULL／PK，支援複合主鍵；下方屬性面板也可修改 SQL 預設值。支援跨欄位連續修改並保留草稿，一起預覽 SQL 後套用。新增／刪除欄位仍分開操作，新增時也可勾選 PK。View 的「設計檢視」入口則編輯完整 View 定義。套用成功會刷新資料頁欄位，並清除舊排序／篩選。

草稿與基準版本會保存，關閉／重新整理前會確認是否捨棄；套用時檢查結構是否已被其他工作階段修改。資料列與結構草稿分開操作，須先儲存或還原才能互相切換。SQLite 修改既有欄位時會以交易重建，保留資料、索引及 Trigger 並檢查外鍵；MySQL／MariaDB 使用原生 DDL 隱含提交。刪除欄位、型別轉換與主鍵變更使用 destructive 權限，其餘使用 DDL 權限。

完整引擎差異、特殊物件限制及原廠文件見 [STRUCTURE_EDITING.md](features/structure-editing.md)。桌面驗證：`npm run test:desktop:structure`。

## 日常操作改善：第一輪迭代

本輪改善日常操作：

- SQL 執行按鈕與 Ctrl／Cmd + Enter 共用同一個入口；有選取時執行選取文字，否則執行完整文字。按鈕會顯示目前模式；空白 SQL 不送出，每次仍限一個敘述。
- 工作頁固定顯示連線、database、schema 與物件來源；SQLite 使用短檔名，tooltip 保留完整路徑。分頁同名且來源不同時補上來源標籤。
- 物件支援右鍵、⋯ 選單、Enter 開啟與 Shift+F10 選單；資料表／View 可直接選擇「設計結構」。同一物件已開啟時沿用分頁，未儲存資料與結構仍須先儲存／還原才能切換。
- 分頁只保留 X 關閉按鈕；在分頁上按右鍵可選擇「關閉」或「關閉其他分頁」。操作以右鍵點選的分頁為對象，未儲存內容仍須確認捨棄；Escape 關閉選單並還原焦點。
- 左上角按鈕可收合連線清單；側欄寬度與 SQL 編輯器／結果區的上下比例會在本機記住。分隔線同時支援滑鼠與方向鍵。
- 「新增列」預設使用欄位表單：省略欄位交由資料庫套用預設／自動產生值，NULL 與空字串分開。保留進階 JSON 模式，切回表單會驗證可表示的欄位與值；錯誤保留輸入。BIGINT／DECIMAL 欄位以文字輸入保留精度。metadata 尚無完整的自動產生欄位能力資訊，這類欄位應保持省略。
- 篩選可清除並顯示已套用條件；排序顯示方向；修改儲存格有色彩標記，頁尾顯示待儲存列數。逐列提交失敗會顯示已成功／待處理列數，沒有改為整批原子交易。

專用回歸驗證：`npm run test:desktop:ui`。既有完整桌面、物件與結構測試仍使用原本命令。這輪沒有更新 `release/` 發行包；使用 `npm run dev` 或建置後 `npm start` 查看新版。

## 結果操作與多條件篩選

- 資料表 Data 頁首次讀取、刷新、翻頁、排序及套用篩選時，頂部顯示旋轉圖示與「資料讀取中…」。讀取期間保留先前結果並沿用操作停用保護，最新讀取完成或失敗後移除提示；錯誤仍使用既有訊息流程。減少動態效果設定會停止旋轉，但保留文字。此顯示適用所有使用資料表 Data 頁的 SQL 引擎，不改變後端讀取或權限。
- 資料表 Data 頁在「重新整理」旁提供「過濾」開關，展開右側直立條件面板（預設收合）。收合保留條件草稿及已套用篩選，按鈕顯示已套用條件數；可用面板關閉按鈕或 Escape 收合。窄資料區改為右側覆蓋面板，條件清單獨立捲動。可以新增最多 30 個篩選條件，按「套用」後以 AND 組合送出。支援移除單一已套用條件及清除全部；NULL 條件不需要值，空字串是有效篩選值。有未儲存資料修改時禁止變更篩選，套用或移除條件會回到第一頁。
- 查詢／資料表結果提供「複製目前頁」「複製選取列」及「匯出目前頁」。複製透過固定 IPC 使用桌面剪貼簿，使用包含欄名的 TSV；匯出提供 UTF-8 CSV／JSON，透過桌面原生儲存視窗選擇檔案。只包含目前頁及可見欄位，包含已反映在表格的未儲存修改；不會自動讀取其他頁面。切換查詢結果頁後清除列選取。
- CSV 對引號、分隔字元與換行做引用／跳脫，NULL 使用空白欄位；JSON 保留 NULL、空字串、布林與數值，驅動以文字回傳的 BIGINT／DECIMAL 保持文字。匯出最多 16 MiB，取消儲存不寫入檔案；操作稽核只記錄格式與位元組數，不記錄匯出內容。`file.result.save` 僅供桌面使用者，MCP 工具數量維持 16 項。
- 儲存格的查看按鈕支援滑鼠與鍵盤，開啟唯讀長文字／JSON 檢視器，可複製原始內容、切換原始／格式化 JSON。格式化保留原始數字字面值；大於 1 MiB 或巢狀超過 64 層的 JSON 使用原始文字檢視。

專用桌面驗證：`npm run test:desktop:result-tools`，使用隔離 SQLite 資料與原生儲存視窗替身，驗證篩選、草稿保護、複製、匯出、取消、精確 JSON 檢視及中英文／明暗／720p／1080p 布局。`npm run test:desktop:table-loading` 使用實際 TableView 與可控制完成的 IPC 替身，驗證慢速首次讀取、刷新／翻頁、成功／失敗／空結果、重疊請求與減少動態效果；不連接真實資料庫或讀取業務資料。

Redis 多資料庫桌面驗證：啟動整合測試服務並完成建置後，執行 `node scripts/smoke-redis-databases.mjs`。

### Redis Stream 與 JSON

支援截圖中的七種型別：string、list、set、zset、hash、stream、json。Stream 以項目 ID 和動態欄位表格呈現，支援下一頁、新增與刪除項目；重複欄位保留所有值，ID 使用字串避免精度遺失。既有項目不可原地修改。新增時 ID 可填 `*` 自動產生，內容可填字串值的 JSON 物件（例如 `{"level":"info","message":"Hello"}`），或配對陣列 `[["field","value"]]` 保留重複欄位。

JSON 使用原生 `JSON.GET`／`JSON.SET`，支援物件、陣列與單一 JSON 值；需伺服器提供 RedisJSON 指令。儲存前驗證 JSON 語法，維持原生型別與 TTL。沒有 JSON 能力的伺服器會顯示明確錯誤。其他擴充模組型別目前只提供型別／TTL 資訊、修改期限及刪除鍵，不會套用錯誤的集合編輯器。

啟動整合服務並建置後，執行 `node scripts/smoke-redis-types.mjs` 驗證七種型別開啟、Stream 分頁／新增／刪除、JSON 新增／編輯與 TTL 保留。協定參考：[XRANGE](https://redis.io/docs/latest/commands/xrange/)、[Redis JSON](https://redis.io/docs/latest/develop/data-types/json/)。

## 建立 Table／View／Index／Trigger

在資料庫瀏覽器對應群組點「＋」或右鍵選擇建立，填寫獨立分頁表單、預覽 SQL 後建立。支援依引擎的欄位型別、NULL／複合主鍵、View SELECT、索引欄位順序與 Trigger 時機／內容；PostgreSQL 可同交易建立觸發函式。草稿可還原，建立後自動刷新列表。詳細能力差異、驗證及進階功能界線見 [OBJECT_CREATION.md](features/object-creation.md)。

四類 SQL 物件的新增／修改／刪除盤點、入口與限制，見 [OBJECT_CRUD_AUDIT.md](features/object-crud-audit.md)。

## 外鍵與 CHECK

在資料表名稱上按右鍵選擇「設計資料表」，可使用「外部索引鍵」「檢查」頁籤列出、新增、修改或刪除約束。外鍵可選來源與目標欄位，複合鍵依畫面配對順序產生；切換 schema／資料表會清除失效選擇。變更先保存草稿，再使用工具列「預覽變更」及「套用變更」。重新載入分頁可恢復草稿，伺服器結構已被其他操作變更時會要求重新整理。

可用 referential action 與「不強制執行」選項依引擎篩選。MySQL CHECK 需 8.0.16+，MariaDB 需 10.2.1+；MySQL NOT ENFORCED 與 SQL Server 停用 CHECK 已實作。ASE 不支援 CASCADE 等動作，只提供 NO ACTION。SQLite 使用交易重建並檢查完整性；特殊延後檢查、MATCH、NOT VALID、複寫或跨資料庫 ASE 約束保留編輯限制，避免遺失原始語意。

MySQL／MariaDB 的同名外鍵修改必須分段執行，期間存在約束未生效的空窗。預覽會顯示此限制與原始復原 SQL；失敗時嘗試還原，若還原失敗必須依訊息與復原 SQL 處理。此操作不能視為交易式原子變更。

`npm run test:desktop:constraints` 驗證桌面流程（SQLite，不需 Docker）；`npm run test:integration` 在測試服務啟動後驗證網路資料庫的實際約束行為。

## 欄位與資料表選項

「設計資料表」新增「欄位選項」及「資料表選項」頁籤。欄位選項先選擇欄位，再編輯註解、字元集、定序或二進位比較；資料表選項可編輯儲存引擎、預設字元集／定序及註解。只顯示目前引擎可用的設定，沿用工具列的預覽、套用、放棄及草稿恢復流程。

MySQL／MariaDB 提供全部上述選項，定序依伺服器與字元集篩選，MariaDB UCA 定序使用完整名稱。二進位比較使用文字欄位的 `_bin` 定序；關閉會回到字元集預設定序。資料表的字元集與定序修改只設定新增欄位的預設值；既有資料需在欄位選項逐欄轉換。PostgreSQL／SQL Server 提供註解與文字欄位定序，SQLite 提供欄位定序，ASE 尚不提供本批屬性。

字元／定序／儲存引擎修改使用 destructive 權限，註解使用 DDL 權限；MCP 和 GUI 經過同一命令流程。伺服器會檢查索引相依、資料相容性與權限；不自動刪除相依物件來強行套用。SQLite 定序變更使用交易重建，保留資料與相依索引／觸發器，違反唯一性時回滾。

先啟動整合服務，再執行 `npm run test:desktop:structure-properties` 驗證 MySQL 桌面操作。`tests/structure-properties.test.ts` 包含五種服務的資料／屬性回讀，以及 SQLite 失敗回滾和共享權限驗證。

## 產生欄位

新增資料表時，可在「產生欄位」區段啟用欄位的產生運算式；既有資料表則從「設計資料表 → 產生欄位」新增、修改或刪除。使用純量 SQL 運算式，例如 `qty * price`，選擇 Virtual（讀取時計算）或 Stored（儲存計算結果）。SQL Server 由運算式推導型別，Stored 對應 PERSISTED。草稿、預覽、套用與版本衝突檢查沿用既有流程。

SQLite 支援兩種儲存方式及互相切換，重建時保留資料、索引、觸發器與自動編號高水位。MySQL 5.7+／MariaDB 支援建立及修改運算式，但此介面不以 drop/add 強行切換既有 Virtual／Stored。PostgreSQL 12+ 支援 Stored，17+ 可修改 Stored 運算式；18+ 可建立 Virtual，既有 Virtual 運算式與儲存方式依原生限制不提供直接修改。ASE 尚未開放此功能。

SQL Server 修改運算式會在同一交易內替換計算欄位，欄位移至最後；保留 MS_Description 註解，相依索引／約束會阻止變更。有自訂欄位權限或其他擴充屬性時拒絕替換，以免遺失設定。只切換 PERSISTED 使用原生 ALTER COLUMN。一般欄位不會被這個表單直接轉成計算欄位；identity／auto increment 也不視為可編輯的產生運算式。

資料頁中的產生欄位為唯讀，新增列由資料庫計算；共用資料寫入命令亦拒絕直接指定其值。產生欄位表單不接受預設值及主鍵，新增時的可空值由引擎決定。`npm run test:desktop:generated-columns` 使用獨立 SQLite 檔驗證桌面流程，不需 Docker；網路 SQL 方言及實際計算值由 `npm run test:integration` 驗證。

## UI 設計規範

新增或修改介面時，套用 [database-workspace-ui skill](../.agents/skills/database-workspace-ui/SKILL.md)。規範包含布局、字型、明暗語意色、間距、控制項與分類 Tabs；共用參數在 `src/renderer/src/design-system.css`。本輪由整體布局到共用元件的盤點與修正見 [UI_DESIGN_REVIEW.md](history/ui-design-review.md)。

按鈕的 size、寬高與使用情境依 [UI_BUTTON_SIZES.md](design/ui-button-sizes.md)。導覽列 `+`、更多、展開、重新整理和分頁關閉統一使用 `icon-sm`（28×28）；密集表格圖示為 24×24，對話框關閉為 32×32。尺寸由共享 Button 管理，個別畫面不覆寫動作按鈕寬高。

執行 `npm run test:desktop:ui-design` 可用獨立 SQLite 檔案驗證選單留白、工具列尺寸、View 分類與草稿、Index／Trigger 分類，以及中英文、明暗／system 主題和小視窗對話框；不需啟動外部資料庫。
