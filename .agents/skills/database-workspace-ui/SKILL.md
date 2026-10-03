---
name: database-workspace-ui
description: 建立、修改或審查 Database Workspace 桌面介面時，套用專案的布局、字型、色彩、間距與元件規範，並驗證中英文及明暗主題。
---

# Database Workspace UI 規範

本規範適用本專案 renderer。先閱讀本文件，再修改 UI。共用参数實作於 `src/renderer/src/design-system.css`，色彩實作於 `theme.css`；個別畫面布局在 `styles.css`。新增參數時同步更新本規範，不在個別畫面另訂同用途尺寸。

## 由大到小的審查順序

1. App shell：標頭、連線列、資料庫列、工作區、狀態列；各區 `min-width/min-height: 0`，長內容在所屬區域捲動。
2. 工作分頁：路徑、動作工具列、分類 Tabs、內容、SQL 預覽；保留可見的動作及選取狀態。
3. 表單、資料表、選單、對話框及提示；最後檢查字型、間距、對齊、截斷、鍵盤焦點和停用狀態。
4. 用實際桌面畫面驗證 1280×720 與 1920×1080、中英文、明暗主題；系統主題須跟隨作業系統。檢查捲動底部仍可操作、沒有整頁水平溢出。

## 布局

- 主要內容靠左，導覽名稱靠左；圖示及勾選框才可置中。工具列左側放標題／局部動作，右側放重新整理、還原與主要提交動作。
- 工具列最小高度 48px，padding 8px 16px，gap 8px；必要時換行。導覽標頭 40px，工作分頁列 40px，狀態列 28px。
- 內容 padding 16px，對話框 24px，段落間距 24px，表單欄位 gap 16px，label 到 control 8px。
- 表單採 `repeat(2, minmax(0, 1fr))`；可用寬度小於 560px 改單欄。長 SQL、說明與成對欄位可跨欄；輸入框最小寬度不得撐破容器。
- 物件設計器使用同一組分類 Tabs。View 為「定義／欄位／進階」；Index 為「定義／選項／原始定義」；Trigger 為「定義／原始定義」。不把 SQL、屬性及唯讀 metadata 堆成長列表。
- Tabs 切換只改顯示，不清除草稿或預覽；切換到另一種編輯模式時，保留既有互斥與「套用／還原」提示。預览及套用共用同一份草稿。
- 既有 Table 的欄位 grid 保留專用水平捲軸。資料表列高 34px（虛擬捲動計算依此值），grid 內控制項可縮至 24px；不得只改 CSS 而不同步虛擬列計算。

## 字型與色彩

| 用途                          | 規格                                                                        |
| ----------------------------- | --------------------------------------------------------------------------- |
| UI 本文、label、button、menu  | 13px / 20px，Segoe UI、Microsoft JhengHei、sans-serif                       |
| 次要資訊、狀態、表格 metadata | 12px / 18px，使用 muted-foreground                                          |
| 區塊標題                      | 16px / 24px，600                                                            |
| 對話框標題                    | 20px / 28px，600                                                            |
| SQL／程式文字                 | 13px / 20px，Consolas、Cascadia Code、monospace；Monaco 尊重設定內 fontSize |

- 使用語意色：background、card、popover、foreground、muted-foreground、primary、border、destructive、success、warning。各色同時提供明暗值。
- hover 使用 secondary，選取使用 primary 12% 混色；錯誤用 destructive，成功用 success，未儲存用 warning。狀態同時有文字或圖示，不只靠顏色。
- 禁止在畫面用固定深色背景或紅綠色；使用者自訂連線色、語法 token、資料視覺化色可例外。

## 元件參數

| 元件                                             | 參數                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Button / Input / Select                          | 預設高 32px，padding-x 12px，gap 8px，圓角 6px；小尺寸 28px，密集 grid 24px                                   |
| Icon button                                      | 依 [按鈕尺寸規範表](../../../docs/design/ui-button-sizes.md) 選擇 size；導覽動作固定 28×28px；aria-label 必填 |
| Menu / Context menu / Select / Autocomplete item | 最小高 36px，padding-y 8px、padding-x 12px，gap 8px，靠左，文字換行時可增高                                   |
| Menu popup                                       | padding 4px，最小寬 180px，圓角 8px；用 available-height 限制高度並捲動                                       |
| 分類 Tabs                                        | 最小高 40px，padding 8px 16px，gap 4px，左對齊；不足寬時在列內水平捲動                                        |
| Checkbox                                         | 16×16px，與標籤 gap 8px，焦點清楚可見                                                                         |
| Fieldset                                         | padding 16px、圓角 6px、1px border；legend 600、padding-x 8px                                                 |
| Alert / Popover                                  | padding 16px、gap 8px、圓角 8px；長字串換行                                                                   |
| Dialog                                           | 一般寬 620px、設定 720px、SQL 檔案 920px；外緣至少 16px，高度 ≤ viewport−48px，內容捲動                       |

- 儲存／建立／套用為 default；重新整理／還原／取消為 outline。物件群組的 `+`、列內 Set NULL、選單及關閉按鈕為 ghost。
- 修改按鈕前先閱讀 [UI_BUTTON_SIZES.md](../../../docs/design/ui-button-sizes.md)。同列、同層級圖示動作必須用相同 size，包含 `+`、更多、展開、重新整理及分頁關閉；不得由圖示內容決定尺寸。
- 尺寸唯一來源為 `design-system.css` 的共用變數及 Button size API；InputGroupButton 必須傳遞相同 size。禁止在區域 CSS、inline style 或 className 另訂動作按鈕寬高、padding、flex-basis。導覽名稱列及資料表排序標頭是延展項目，例外集中在共用規範檔，不能影響相鄰圖示動作。
- 保留 hover、focus-visible、disabled 與 danger 的語意。停用、選取、載入及開啟選單時均不可改變尺寸。
- 所有互動用現有 shadcn / Base UI primitive；使用固定 IPC bridge，布局改動不可改變權限或資料操作流程。

## 提示與驗證

- 結構變更提示留在工具列「重新整理結構」左側，點選開浮動明細；不得插入大段提示讓正在編輯的欄位位移。
- 非模態 toast 位於底部動作區上方，只有關閉按鈕攔截點擊；通知不得阻擋資料列儲存／還原操作。
- 檢查 menu 上下 padding、截斷、長連線名、空狀態、資料超量、未儲存與失敗狀態。對話框可捲到底且按鈕可達；分類 Tabs 支援方向鍵與可辨識名稱。
- 改動後執行 typecheck / build 及相應 desktop smoke。驗證實際 offsetWidth/offsetHeight、padding 和 size，不只搜尋 className；必須逐項比對 Table／View／Index／Trigger 群組的 `+` 和更多按鈕，以及連線列、資料庫列、分頁和密集 grid。測試使用獨立資料目錄與自己建立的 SQLite／整合物件。
- 保留其他使用者的 Electron 程序及資料庫服務；不得為 UI 驗證輸出測試密碼。
