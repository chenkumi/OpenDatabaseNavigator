# 使用者介面分析與 Base UI 重構

## 目標與邊界

全面以 shadcn/ui Base UI 版本統一互動元件、樣式與無障礙行為。保留桌面資料庫工具的緊湊密度、三欄可調版面、雙語及明暗主題；不改動 Command Bus、IPC、權限與資料庫服務。

## 盤點與遷移範圍

| 區域 | 現況／問題 | 目標 |
| --- | --- | --- |
| 應用框架 | 手寫按鈕、分頁、狀態、通知；只有 Resizable 改寫自 shadcn | Button、Tabs、Badge、Alert、Breadcrumb、Resizable |
| 連線與資料庫瀏覽器 | 自行定位選單、管理方向鍵、右鍵與焦點；新增 DB 手寫 modal | Dropdown Menu、Context Menu、Dialog、Input、Select |
| 連線表單 | 原生表單與無焦點管理浮層 | Dialog、Label、Input、Checkbox、Select，保留密碼與引擎條件欄位 |
| 設定與 MCP 核准 | 自製焦點圈選、原生 checkbox/select、瀏覽器 confirm | Dialog、Alert Dialog、Checkbox、Select、共用確認服務 |
| SQL 工作區 | Monaco、自製工具列、虛擬結果表 | 保留 Monaco 和 TanStack 虛擬化，工具列及結果控制項全面遷移 |
| Table／View 設計 | 手寫 tabs、datalist、原生編輯欄位 | Tabs、Combobox 型別建議、Input 數字欄位、Checkbox NULL／複合 PK |
| Index／Trigger／新增物件 | 原生表單、details、按鈕 | 共用表單元件、Collapsible、預覽及執行流程保留 |
| 結構變更提示 | 原生 popover 與手動定位 | Popover，維持工具列位置、不擠動內容 |
| 新增資料列／刪除／重新命名 | 各自實作 portal/modal，焦點管理不一致 | 共用 Dialog，保留草稿、busy 防重送與 SQL 預覽 |
| Redis | 各型別編輯器、原生選單與 confirm | 共用表單、Table、Alert Dialog，保留分頁及集合操作 |
| 結果與資料表 | TanStack 虛擬化與大量資料編輯 | 保留資料模型與虛擬列，共用表格樣式及編輯元件 |

## 實作決策

- 從官方 `base-nova` registry 取得元件原始碼（MIT），使用 `@base-ui/react`，不混入 Radix primitives。
- 建立 Tailwind v4、shadcn 配置、`cn` 工具與明暗色彩 tokens。資料密度採 Nova 的緊湊尺寸。
- 先建立元件基礎，再移除各畫面的原生互動實作；安裝元件但沒有接入畫面不算完成。
- 原生 HTML 僅保留語義結構及需要的專用控制項；Monaco／TanStack 是專業編輯及虛擬化引擎，與 shadcn 元件整合。
- 驗證包含 TypeScript、一般測試、獨立 SQLite 桌面流程、鍵盤／焦點／關閉行為，以及明暗主題與不同視窗尺寸。

## 進度與驗證

- [x] 完整盤點 renderer 畫面與互動類型。
- [x] 建立官方 Base UI 元件及主題基礎。
- [x] 全部畫面改用共用元件。
- [x] 替換自製選單、modal、confirm、popover、tabs 與 datalist。
- [x] 移除衝突／重複樣式並完成視覺檢查。
- [x] 完成全範圍測試與最終覆蓋審核。

參考：[shadcn/ui](https://ui.shadcn.com/llms.txt)、[Base Button](https://ui.shadcn.com/docs/components/base/button)、[官方元件原始碼](https://ui.shadcn.com/r/styles/base-nova/button.json)。

## 實作結果與重要差異

- 共用層：`components/ui` 放置官方 `base-nova` 元件；`theme.css` 是色彩、圓角和明暗主題的單一來源，既有布局 CSS 使用這些 tokens。
- `SelectField` 組合 Select／Trigger／Content／Item，以值回呼取代原生 DOM change event，涵蓋引擎、認證、設定、資料篩選、資料列及 Redis 型別。
- `TypeCombobox` 依引擎提供型別搜尋，仍接受自訂型別；長度／精度與小數位數保持獨立 Input。鍵盤 Escape 關閉建議，選項不限制自訂 SQL 型別。
- Checkbox 用於 NULL、PK、資料列選取、欄位顯示、設定及建立物件；Base Fieldset 傳遞停用狀態。明確的無障礙名稱優先於 PK 序號等裝飾文字。
- ActionMenu 共用 Dropdown Menu 與 Context Menu，使用 detached trigger，避免兩種入口被當成巢狀選單；保留方向鍵、Home／End、Escape 和焦點回復。
- 六種表單對話框採用 Dialog：連線、設定、新增資料列、新增資料庫、刪除、重新命名。ConfirmDialog 集中處理捨棄草稿、刪除資料及 Redis 確認；重複點擊不排入隱藏佇列。
- 工作區、Data／Structure 與 Fields／Primary key 使用 Tabs；工作區分頁保持掛載以保留未儲存內容。路徑改用 Breadcrumb，結構通知與欄位顯示選擇改用 Popover。
- 一般表格及虛擬查詢結果都用共用 Table；TanStack 保留分頁、虛擬列、欄寬、排序和草稿模型。Monaco 保留 SQL 編輯與自動完成。
- 樹狀導覽與業務面板是上述元件的組合，不引入另一套 UI primitives。Electron 原生檔案選擇、作業系統選單和離開程式保護仍屬桌面外殼。
- Tabs、Separator 與 Scroll Area 的方向樣式對應 Base UI 1.8 的 `data-orientation`；Dropdown Menu 採非模態模式，保留點擊搜尋框等外部控制項關閉選單的行為。
- `licenses/shadcn-ui.txt` 保留 MIT 授權，`licenses/shadcn-registry.json` 記錄官方來源。`scripts/import-shadcn.mjs` 是原始來源匯入工具；重新匯入前須比對應用程式對 Checkbox、Table、Tabs、Separator、Scroll Area 的調整，不宜直接覆蓋。

## 驗證紀錄（2026-09-29）

- TypeScript 與 production build 已通過。
- 一般測試：85 通過、29 因未啟用真實服務／環境而略過。
- `smoke-create-objects.mjs`：四類物件新增、SQL 預覽、真實 trigger、刪除、草稿重載及未儲存保護通過。
- `smoke-rename-objects.mjs`：四類重新命名、重名與未儲存保護、分頁／樹更新通過。
- `smoke-ui-iteration.mjs`：部分儲存、新增資料列驗證、預設值／布林／NULL，以及 1280×720 亮色與 1920×1080 暗色布局通過。
- `smoke-redis-types.mjs`：七種型別開啟、Stream 分頁／新增／刪除、JSON 建立／編輯及 TTL 保留通過。
- `smoke-structure.mjs`：直接編輯型別／名稱、獨立精度、NULL／複合 PK、SQL 預覽／套用、失敗草稿保留、View 衝突、重新載入通過；新增頁籤、工具列與網格的幾何位置斷言。
- `smoke-object-tabs.mjs`：Index／Trigger 編輯、失敗保留與資料作用通過。
- `smoke-connections.mjs`：冷啟動離線、連線／中斷、未儲存取消及分頁清理通過。
- `smoke-agent-redis.mjs`：Redis 寫入／TTL、MCP 共享命令、核准及取消通過。
- `smoke-sybase.mjs`：ASE 連線表單、TLS、缺少驅動提示及憑證保護通過；未有 ASE 真實伺服器可驗證。
- 視覺檢查：深色表格設計器、Redis Stream、淺／深色查詢結果與緊湊導覽。主題切換測試等待文字／背景到達最終色彩，避免把轉場中間畫面誤判為樣式錯誤。
- 最終建置另檢查 `.local/base-ui-designer-light.png`、`.local/base-ui-designer-dark.png`、`.local/base-ui-insert-light.png`、`.local/base-ui-rename-light.png`；設計器與表單標籤排列、按鈕、輸入框及對話框皆正常。
- 靜態盤點：renderer 應用畫面沒有殘留原生 select／datalist、瀏覽器 confirm 或手動 createPortal；不含 Radix 相依套件。
- `smoke-electron.mjs`：完整桌面回歸通過，涵蓋選單方向鍵／End／Escape／焦點還原、外部點擊關閉、設定焦點圈選、連線、虛擬資料表編輯、篩選／排序／隱藏欄、資料列新增／刪除、SQL 選取執行、分頁拖曳、歷史紀錄、雙語設定及重新載入。

## 交付界線

本次是 UI 元件與互動重構，沒有修改 adapter 或 GUI／MCP 共用命令的權限邊界。SQLite 桌面操作和 Redis／MCP 流程使用隔離測試資料；外部 SQL 引擎未全面重新做真機驗收，ASE 仍屬實驗性支援。`release/` 安裝包未重新封裝，使用 `npm start` 開啟已建置的介面。
