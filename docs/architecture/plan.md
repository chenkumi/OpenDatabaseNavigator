# Database Desktop App — 計畫索引

本計畫描述一套跨平台 Desktop Database Client，以及讓 Agent 透過 Remote MCP 與使用者共用 Workspace 的 Phase 1 產品方向。

核心原則是讓 GUI 與 Agent 共用 Application Services、Command Bus、權限控管與資料庫介面；Agent 操作的是 App 能力，憑證則留在 App 內管理。

## 計畫分段

| Part | 主題 | 涵蓋章節 |
| --- | --- | --- |
| [Part 01 — 產品定位與桌面資料庫功能](plan-parts/01-product-scope-and-desktop-client.md) | 產品定位、Phase 1 原則，以及連線、Explorer、Workspace、SQL、資料表與 Redis 的桌面功能。 | 1–20 |
| [Part 02 — MCP 架構與 Agent 能力](plan-parts/02-mcp-architecture-and-capabilities.md) | Remote MCP、認證與權限模型、Tools、Resources、App Context，以及 Command Bus 和 Event Bus。 | 21–39 |
| [Part 03 — Agent 安全與操作治理](plan-parts/03-agent-security-and-governance.md) | 操作核准、破壞性操作、活動與稽核紀錄、憑證隔離、結果格式和大型查詢分頁。 | 40–49 |
| [Part 04 — Agent 工作流程與 Phase 1 交付](plan-parts/04-workflows-and-phase-one-delivery.md) | Agent 使用情境、Phase 1 MCP 清單、狀態提示、Remote 安全、Electron 結構、交付範圍與產品差異。 | 50–58 |

## 閱讀順序

建議依 Part 01 → Part 04 閱讀：先理解產品與桌面功能，再讀 MCP 能力、安全治理，最後看完整工作流程與 Phase 1 交付範圍。各 Part 保留原本的章節編號，方便引用與追蹤。

## Phase 1 範圍摘要

- **Desktop App：** Connection Manager、Database Explorer、SQL Editor、Query Result、Table Browser、Basic CRUD、Redis Browser。
- **Agent：** Remote MCP、App Context、Schema、Query、Data 與 Workspace 操作。
- **共用核心：** Application Services、Command Bus、Event Bus、Permission、Audit 與 Credential Storage。
