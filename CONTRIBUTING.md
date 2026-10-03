# 貢獻指南 · Contributing

感謝你願意貢獻！Thanks for contributing! 中文與 English 皆可用於 issue、PR 與討論。

## 開發環境 · Setup

需要 **Node.js 24+** 與 npm。

```sh
npm install
npm run dev
```

## 提交前請確認 · Before you open a PR

```sh
npm run typecheck
npm test
npm run build
npx prettier --check .
```

- 變更資料庫相關行為時，請同時跑真實資料庫的整合測試（需要 Docker）：`npm run integration:up`，再 `npm run test:integration`，完成後 `npm run integration:stop`。`npm test` 會略過這些測試，**綠燈不代表資料庫整合正確**。
- 變更畫面時，請跑桌面煙霧測試：`npm run test:desktop:all`。
- 修 bug 請附能重現問題的測試；新功能請附對應測試。

## 架構界線 · Architecture rules

- GUI 與 MCP 共用 **Command Bus、權限層、服務與事件匯流排**。新增資料操作請沿用，不要繞過權限，也不要從 renderer 直接操作資料庫。
- 主程序、preload、renderer 與資料庫 adapter 職責分層；renderer 只透過固定的 IPC 橋接存取主程序。
- 新增資料庫引擎請依 [新增資料庫支援規格](docs/new-database-support.md)。
- 修改 renderer 介面請遵守 [UI 設計規範](.agents/skills/database-workspace-ui/SKILL.md)；共用尺寸與字級在 `design-system.css`，不要在個別畫面另訂。

## 安全與機密 · Security and secrets

- **不要**提交密碼、token、私鑰或真實資料。整合測試密碼放在被忽略版控的 `.local/integration.env`。
- 截圖與範例請使用測試資料，不要包含你自己的資料庫或主機名稱。
- 發現安全漏洞請依 [SECURITY.md](SECURITY.md) 私下通報，不要開公開 issue。

## 提交訊息與 PR · Commits and pull requests

- 一個 PR 專注一件事；說明「為什麼」與如何驗證，並列出你跑過的測試。
- 提交訊息用簡短祈使句描述變更（中文或英文皆可）。
- CI 會執行型別檢查、單元測試與建置，須全數通過。

## 回報問題 · Reporting issues

請使用 issue 範本，附上作業系統、Node 版本、資料庫種類與版本，以及可重現的步驟。
