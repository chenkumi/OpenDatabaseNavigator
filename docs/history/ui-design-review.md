# UI 規範與統一審查

日期：2026-09-30。規範來源：[database-workspace-ui skill](../../.agents/skills/database-workspace-ui/SKILL.md)。

本輪由 App shell、工作分頁、編輯器到共用元件依序審查 renderer。色彩由 `theme.css` 管理；尺寸、字型及密度由 `design-system.css` 管理；`styles.css` 保留個別區域的布局。使用者指定的連線色、Monaco 語法色、可調字體、虛擬表格及分割面板幾何屬性是有意保留的差異。

## 由大到小的結果

| 層級／區域 | 發現 | 處理 |
|---|---|---|
| App shell、連線／資料庫瀏覽器 | 導覽留白、欄位與動作大小各自定義；搜尋框到群組標題空隙過大 | 四像素間距系統，導覽搜尋框 32px，列內容靠左，清理搜尋與群組間距；保留可調面板及區域捲動 |
| 工作分頁、路徑、工具列 | 7／9px gap、10／11px 文字、同類工具列尺寸不同 | 共用 8px gap、48px 工具列及一致控制項文字；名稱可截斷、動作可換行 |
| Table 設計器 | 已有分類 Tabs，與其他設計器不同；分類列可能出現垂直捲軸 | 保留原有分類，將分類列作為共用布局，左對齊、只在列內水平捲動 |
| View 編輯與新增 | 欄位、進階選項、SQL 定義堆成長列表 | 編輯分成定義／欄位／進階；新增分成定義／進階；依引擎能力顯示進階。分頁切換保留草稿及原有 SQL／屬性互斥 |
| Index／Trigger 編輯 | 屬性、SQL、原始定義直接堆疊 | 採共用分類列；Index 定義／選項／原始定義，Trigger 定義／原始定義；預覽／套用維持原流程 |
| 欄位、索引、檢視屬性及約束表單 | 14／18px gap，label 與控制項大小不一致，下拉欄位未填滿欄寬 | 表單 gap 16px、label gap 8px、控制項 32px；窄內容區改單欄；定義者帳號勾選列跨欄 |
| 連線選單、物件選單、右鍵選單 | 選單列 padding-y 僅 4px，視覺與操作過密 | 全部共用最小列高 36px、上下 8px／左右 12px；刪除連線使用 destructive 語意 |
| Select／Autocomplete／Button／Input／Checkbox | primitive 與區域 CSS 使用不同密度 | 透過 data-slot、data-size 統一參數；保留 ghost 的物件新增與 Set NULL；checkbox 16px，密集控制項有明確小尺寸 |
| 資料 grid、Redis 鍵與數值 | 固定選取色、綠色、密度有差異 | 使用 semantic primary／success／warning；Redis 列靠左；grid 保留 34px 列高與 24px 控制項，和虛擬捲動一致 |
| 連線、設定、列新增、物件操作、SQL 檔案／匯出對話框 | 部分 close 使用 outline、部分 ghost；SQL dialog inline 寬度，長連線表單將動作捲出畫面 | 關閉使用 ghost；對話框 24px padding、標題及欄位對齊；連線表單內容獨立捲動，標頭／底部動作保持可見；SQL dialog 改用共用尺寸 class |
| Notice／Popover／Toast／活動與歷史 | 部分固定深紅背景或舊色碼無法跟隨 light | semantic 色與共用 16px 內距；結構提示維持工具列浮動明細；toast 移到下方動作區上方且背景不攔截點擊，避免阻擋還原 |

## 規範維護

- 專案版 skill 已放入 `.agents/skills/database-workspace-ui`，並安裝至本機 Codex 的 skills 目錄供後續使用。`AGENTS.md` 指定後續 renderer 修改應先讀此規範。
- 修改共用參數時，先改規範與 `design-system.css`，再檢查區域布局；不重新複製同用途的硬編碼參數。
- 原生作業系統選單、檔案選取器採用系統布局；資料庫功能及權限保持現有 Command Bus 路徑。

## 驗證命令

- `npm run build`：型別與正式 renderer／主程序／preload 建置。
- `npm run test:desktop:ui-design`：不需外部資料庫，以獨立 SQLite 檔案驗證 menu／context-menu 實際尺寸、720p／1080p、中英文／明暗及 system 主題、View 分類／草稿／方向鍵／預覽、Index／Trigger 原始定義與對話框捲動。
- `scripts/smoke-view-options.mjs`、`scripts/smoke-index-options.mjs`：MySQL 真實建立／修改、草稿還原、失敗保留及 SQL／屬性互斥，測試隨新分類加入分頁操作。
- `scripts/smoke-ui-iteration.mjs`：資料編輯／列新增／查詢及小視窗設定動作。
- `scripts/smoke-redis-types.mjs`：Redis 各型別瀏覽／修改流程。

截圖保存於忽略版控的 `.local/ui-design/`，由 Electron capturePage 擷取，再檢視實際圖像。每次測試使用自己的 App 資料目錄，不更動現有使用者的連線與分頁。

2026-09-30 驗證結果：skill 原始版／本機安裝版的 quick_validate 通過；typecheck 與正式 build 通過；UI design、UI iteration、MySQL View options、Index options、Redis types、Table structure 桌面測試通過。已檢視 1280×720 英文明亮選單、繁中深色 View、連線與設定對話框截圖。UI design 另外驗證 system 主題的明暗切換、工具列 8px gap／8px×16px padding，以及 32px 搜尋框。回歸中發現的 toast 遮擋已修正，原本會失敗的資料列還原操作現在通過。

Table structure 回歸亦確認欄位直接編輯、NULL／複合 PK、預覽／套用、失敗保留與變更提示不推移版面。整合服務已停止；測試建立的 Electron 程序已關閉，原有程式未動。

## 按鈕尺寸補正

資料庫瀏覽器群組的 `+` 沒有指定 size，而更多動作使用 `icon-xs`；共享 CSS 又將 `icon-xs` 覆寫成 28px，區域 CSS 還存在 24×26、20×28 等不同寬高。先前的規範只描述可使用的範圍，沒有指定相鄰動作的尺寸，導致混用。

已新增 [UI_BUTTON_SIZES.md](../design/ui-button-sizes.md)，並修正專案及本機安裝的 skill：導覽、物件群組與分頁動作固定 `icon-sm`（28×28）；密集 grid／Set NULL／輸入框內動作使用 `icon-xs`（24×24）；對話框、浮動視窗及通知關閉使用 `icon`（32×32）。一般文字按鈕 32px，其他 size 及使用情境見規範表。

Button 寬高與 padding 集中在 `design-system.css`，移除 primitive 和區域 CSS 中重複的動作尺寸。InputGroupButton 直接傳遞 size，並使用 `ui-button` class 保留共用尺寸規則，避免 Base UI render 組合替換 data-slot 後失去樣式。輸入框內 addon 不再增加垂直 padding，保持密集欄位高度。

桌面 UI design 測試新增四種群組 `+`／更多的尺寸和 ghost 驗證，實際點選新增入口／選單、檢查停用提交按鈕，並比對所有可見圖示按鈕的寬高、padding、圓角與字型。密集 grid 同時檢查欄位選取、Set NULL 和 autocomplete 展開；語系／主題／視窗尺寸矩陣沿用原測試。

補正驗證：typecheck／build、skill quick_validate、UI design、UI iteration、Table structure 全部通過。已檢視英文明亮及繁中深色截圖；群組兩個動作均為 28×28、padding 0、圓角 6px。桌面測試使用獨立 SQLite，不需啟動外部資料庫。
