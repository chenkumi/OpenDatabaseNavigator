# 專案指引

## 環境

- 讀取文字檔時預設使用 UTF-8。
- 開發需要 Node.js 24+ 與 npm；安裝套件後以 `npm run dev` 啟動桌面程式。

## 架構邊界

- GUI 與 MCP 共用 Application Command Bus、權限層、服務與事件匯流排。新增資料操作時沿用這些服務，不要繞過權限或直接從 renderer 操作資料庫。
- 主程序、preload、renderer 與資料庫 adapter 的職責分層；renderer 只透過固定 IPC bridge 存取主程序。
- 憑證與測試資料有既定保護方式。整合測試密碼位於忽略版控的 `.local/integration.env`，不要將其內容輸出到終端紀錄或文件。

## 驗證

- 依變更範圍執行 `npm run typecheck`、`npm test` 或 `npm run build`；各命令定義於 `package.json`。
- 資料庫整合或桌面流程變更時，先參閱 [docs/USER_GUIDE.md](docs/USER_GUIDE.md) 的「真實資料庫整合測試」及對應 smoke test 命令；整合服務由 `npm run integration:up`／`npm run integration:stop` 管理。

## 專案參考

- 修改或審查 renderer UI 時，先套用 [.agents/skills/database-workspace-ui/SKILL.md](.agents/skills/database-workspace-ui/SKILL.md) 的統一設計參數及由大到小的審查流程。共用參數在 `design-system.css`，不要在個別畫面另訂同用途尺寸。

- [README.md](README.md)：專案簡介與快速開始；文件索引在 [docs/README.md](docs/README.md)。
- [docs/USER_GUIDE.md](docs/USER_GUIDE.md)：開發方式、操作流程、MCP 與安全限制、整合測試說明。
- [docs/history/implementation-log.md](docs/history/implementation-log.md)：各功能的實作範圍與驗證證據。
- [docs/architecture/plan.md](docs/architecture/plan.md)：原始計畫的逐項追蹤與交付界線。
