# 文件索引

專案簡介與快速開始請見[根目錄 README](../README.md)（[English](../README.en.md)）。

## 使用與開發

- [使用與開發指南](USER_GUIDE.md)：操作流程、MCP 與安全限制、連線進階設定、匯出、整合測試與桌面煙霧測試。
- [新增資料庫支援](new-database-support.md)：新增資料庫引擎所需的功能、修改位置、引擎能力表與驗收清單。

## 功能說明（`features/`）

- [建立 Table／View／Index／Trigger](features/object-creation.md)
- [Index／Trigger 編輯](features/object-editing.md)
- [物件重新命名](features/object-renaming.md)
- [Table／View 結構編輯](features/structure-editing.md)
- [物件新增／修改／刪除盤點](features/object-crud-audit.md)

## 資料庫引擎（`engines/`）

- [SAP／Sybase ASE 支援（實驗性）](engines/sybase-support.md)
- [ASE 用戶端編碼：驅動限制](engines/sybase-encoding.md)

## 設計與架構

- [UI 按鈕尺寸規範](design/ui-button-sizes.md)（搭配 [UI 設計規範 skill](../.agents/skills/database-workspace-ui/SKILL.md)）
- [原始計畫索引](architecture/plan.md)：產品範圍、MCP 架構與能力、Agent 安全與操作治理、工作流程。

## 歷史紀錄（`history/`）

這些是開發過程的紀錄，保留當時的決策與驗證證據，**不是**現行使用說明。

- [實作紀錄](history/implementation-log.md)：逐次迭代的實作範圍與驗證結果。
- [功能對照表](history/function-coverage.md)與[原始需求清單](history/requirements.txt)：預定功能與實作的對照。
- [Code Review 2026-09-28](history/code-review-2026-09-28.md)：早期審查與修正（必須避免重現的問題）。
- [UI 重構](history/ui-refactor.md)、[UI 規範審查](history/ui-design-review.md)。
