# 按鈕尺寸規範

本表適用 renderer 的共享 `Button` 與 `InputGroupButton`。實際數值集中於 [design-system.css](../../src/renderer/src/design-system.css)，審查流程見 [UI skill](../../.agents/skills/database-workspace-ui/SKILL.md)。

| size      | 高度 | 寬度       | 水平 padding | 使用情境                                                                     |
| --------- | ---: | ---------- | -----------: | ---------------------------------------------------------------------------- |
| `default` | 32px | 依文字內容 |         12px | 一般工具列、表單、儲存／套用／取消                                           |
| `sm`      | 28px | 依文字內容 |         12px | 緊湊的文字動作                                                               |
| `xs`      | 24px | 依文字內容 |          8px | 密集資料格的文字動作                                                         |
| `lg`      | 36px | 依文字內容 |         12px | 需要強調的大型文字動作                                                       |
| `icon`    | 32px | 32px       |            0 | 對話框、浮動視窗、通知的關閉按鈕，主標頭圖示動作                             |
| `icon-sm` | 28px | 28px       |            0 | 連線／資料庫導覽標頭、群組與物件列的 `+`、更多、展開、重新整理，以及分頁關閉 |
| `icon-xs` | 24px | 24px       |            0 | 密集 grid 欄位選取、Set NULL、輸入框內清除／展開動作                         |
| `icon-lg` | 36px | 36px       |            0 | 大型圖示動作                                                                 |

- 所有按鈕圓角 6px、內部 gap 8px。文字預設 13px／20px；`xs` 使用 12px／20px。
- 同列、同層級圖示按鈕用同一個 size，寬度和高度必須相等；圖示字形不同不影響外框尺寸。
- 停用、hover、focus、選取、載入或選單開啟時維持尺寸。圖示按鈕必須提供 `aria-label`。
- `variant` 只決定外觀，不決定尺寸。導覽圖示、更多、關閉和 Set NULL 使用 `ghost`。
- 在 JSX 明確指定 `size`，不得以區域 CSS、inline style 或尺寸 utility 覆寫共享動作按鈕；`InputGroupButton` 直接使用同一套 size。
- 連線名稱、樹狀名稱、Redis key／資料庫名稱列是可延展的導覽項目，可依內容增加高度並填滿列寬。排序標頭可填滿儲存格。這些布局例外集中在 `design-system.css`，不適用相鄰圖示動作。
- 桌面 smoke 須驗證實際尺寸，涵蓋中英文、明暗主題、1280×720／1920×1080、停用狀態及功能操作。
