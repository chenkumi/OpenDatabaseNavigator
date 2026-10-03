## 變更內容 / What changed

<!-- 說明「為什麼」要改，而不只是改了什麼 / Explain why, not only what -->

## 如何驗證 / How it was verified

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] 變更資料庫行為：已跑 `npm run test:integration`（需 Docker）/ ran the integration tests for database changes
- [ ] 變更畫面：已跑 `npm run test:desktop:all` / ran the desktop smoke tests for UI changes
- [ ] 新增或更新對應的測試 / added or updated tests

## 注意事項 / Notes

- [ ] 沒有提交密碼、token、私鑰或真實資料；截圖只含測試資料 / no secrets or real data; screenshots contain test data only
- [ ] 沒有繞過 Command Bus、權限層，也沒有從 renderer 直接操作資料庫 / does not bypass the Command Bus or permission layer
