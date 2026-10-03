# 安全政策 · Security Policy

## 通報漏洞 · Reporting a vulnerability

請**不要**在公開 issue、討論區或 pull request 貼出漏洞細節或可利用的範例。

請使用 GitHub 的私下通報：在本儲存庫的 **Security** 分頁選擇 **Report a vulnerability**。若該功能未開啟，請先開一個**不含細節**的 issue，說明你想私下通報，維護者會與你聯絡。

通報時請盡量附上：影響的版本、重現步驟、預期與實際行為，以及影響範圍（例如：繞過核准、洩漏憑證、讀寫未授權的資料庫）。

Please do **not** disclose vulnerability details in public issues, discussions or pull requests. Use GitHub private vulnerability reporting (**Security → Report a vulnerability**). If it is not enabled, open an issue _without details_ asking for a private channel.

## 範圍 · Scope

本專案特別關注下列安全邊界，相關問題請優先通報：

- MCP 的認證、Host／Origin 檢查、權限、核准與授權範圍（Agent 不得自行核准或超出已核准的操作）。
- 憑證（資料庫密碼、MCP token）的儲存與洩漏（稽核、日誌、錯誤訊息、工具結果）。
- Renderer 與主程序之間的隔離（`contextIsolation`、sandbox、固定 IPC 橋接）。
- SQL 與識別字的跳脫、連線池狀態污染、取消與逾時是否真的終止伺服端語句。

## 設計上的保護 · Built-in protections

- MCP 預設停用，僅監聽本機；使用 bearer token；遠端存取需 TLS 與明確的 Host 允許清單。
- Agent 的寫入需要桌面使用者核准；破壞性操作每次都要核准；每個連線可設為停用／唯讀／讀寫。
- 憑證用作業系統加密儲存，不會出現在稽核與工具結果中。

## 支援的版本 · Supported versions

專案仍在早期階段（0.x），只修補最新的主分支。
