# Database Workspace

**繁體中文** · [English](README.en.md)

給人類與 AI Agent 共用的桌面資料庫工具。一個 Electron 桌面程式，瀏覽、查詢、編輯多種資料庫；同時內建本機 [MCP](https://modelcontextprotocol.io/) 伺服器，讓 AI Agent 透過**受權限與核准管控**的工具，與你共用同一個工作區。

![Database Workspace 工作區](docs/images/workspace.png)

## 特色

- **多種資料庫**：SQLite、PostgreSQL、MySQL／MariaDB、SQL Server（SQL 帳密，Windows 上另支援 Windows 驗證）、Redis；SAP／Sybase ASE 為實驗性支援（尚未在真實 ASE 驗證）。
- **查詢與資料**：Monaco SQL 編輯器與欄位／資料表補全、虛擬化的大型結果表、行內編輯、最多 30 個 AND 篩選、CSV／JSON 匯出、執行 SQL 檔案、匯出 SQL 備份。
- **結構設計**：資料表／檢視設計器、索引、觸發器、外鍵與 CHECK、產生欄位；建立、重新命名、刪除前都會預覽 SQL，並檢查物件版本。
- **Redis**：字串、Hash、List、Set、Sorted Set、Stream 與 JSON 的瀏覽與編輯，保留 TTL。
- **Agent 共用工作區**：Agent 開啟的分頁、查詢結果與你看到的同步；寫入需桌面使用者核准，所有操作留下稽核紀錄。
- **介面**：繁體中文／English、深色／淺色、可調整的三欄版面。

| 結構設計器                                        | Agent／MCP 共用工作區                          |
| ------------------------------------------------- | ---------------------------------------------- |
| ![結構設計器](docs/images/structure-designer.png) | ![Agent 共用工作區](docs/images/agent-mcp.png) |

## 快速開始

需求：**Node.js 24+** 與 npm。

```sh
npm install
npm run dev        # 開發模式啟動桌面程式
```

```sh
npm run build      # 型別檢查並建置
npm start          # 執行建置結果
npm run package    # 產生 Windows 發行包（release/win-unpacked）
```

> macOS／Linux 的封裝設定已提供，但目前只在 Windows 上驗證過。SQL Server 的 Windows 驗證與 Sybase ASE 僅限 Windows／需另裝驅動。

## 讓 AI Agent 使用（MCP）

MCP 預設**停用**，且只監聽本機。在 _Settings → Agent / MCP_ 啟用並取得 token 後，於 MCP client 設定 Streamable HTTP：

```json
{
  "url": "http://127.0.0.1:7799/mcp",
  "headers": { "Authorization": "Bearer <desktop-generated-token>" }
}
```

- 每個連線可個別設為 **停用／唯讀／讀寫**。
- Agent 的寫入會回傳 `approvalId`，須由桌面使用者核准原始操作，Agent 無法自行核准；破壞性操作每次都要核准。
- 資料庫密碼與 token 只存在桌面端，不會出現在工具結果、稽核或錯誤訊息中。

完整工具清單、授權範圍與限制見 [使用與開發指南](docs/USER_GUIDE.md#mcp)。

## 安全

- 連線憑證以作業系統的加密儲存（Electron `safeStorage`）保存，沒有明文備援。
- Renderer 啟用 `contextIsolation` 與 sandbox，只能透過固定的 IPC 介面存取主程序。
- 發現安全問題請參閱 [SECURITY.md](SECURITY.md)，**請勿**在公開 issue 貼出漏洞細節。

## 開發與測試

```sh
npm run typecheck          # 型別檢查
npm test                   # 單元測試（不需要資料庫）
npm run integration:up     # 啟動 Docker 測試資料庫（PostgreSQL／MySQL／MariaDB／SQL Server／Redis）
npm run test:integration   # 真實資料庫整合測試
npm run test:desktop:all   # 桌面（Electron）煙霧測試
npm run integration:stop
```

`npm test` 會略過所有需要真實資料庫的測試，**綠燈不代表資料庫整合已驗證**。整合測試的密碼由 `integration:up` 產生在被忽略版控的 `.local/integration.env`。更多細節見[使用與開發指南](docs/USER_GUIDE.md#真實資料庫整合測試)。

### 專案結構

| 路徑                   | 內容                                 |
| ---------------------- | ------------------------------------ |
| `src/main/application` | Command Bus、Event Bus、各項服務     |
| `src/main/database`    | SQL 產生器與各資料庫 adapter         |
| `src/main/mcp`         | MCP 伺服器、權限、核准與稽核         |
| `src/main/credentials` | 憑證加密儲存                         |
| `src/preload`          | 固定的 IPC 橋接                      |
| `src/renderer`         | React 介面（Monaco、TanStack Table） |
| `tests`、`scripts`     | 單元／整合測試與桌面煙霧測試         |

GUI 與 MCP 共用同一個 Command Bus、權限層與服務；新增資料操作時請沿用它們，不要繞過權限或從 renderer 直接操作資料庫。

## 文件

文件索引在 [docs/README.md](docs/README.md)：使用與開發指南、各功能說明、各資料庫的支援與限制、新增資料庫引擎的規格，以及歷史設計與實作紀錄。

## 貢獻

歡迎 issue 與 pull request，請先閱讀 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 授權

[MIT](LICENSE)
