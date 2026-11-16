# Neo 研究工作台（C 路線，第一階段）

## 成果與範圍

在公開 Pro Web fork 新增可獨立啟動的研究入口與 `NeoResearchPanel`。沿用 Pro 的 PanelChrome 與 react-grid-layout，支援選股連動、鎖定、拖拉、縮放與研究版面保存。研究頁不載入原版 App、bootstrap、交易快捷鍵、帳務或即時行情服務。

本階段所有數字均為本機合成 fixture；頁首及面板必須明示「示範資料，非真實行情或財報」。不新增券商連線、不更改 neo-client、不以最新財報或真實 neo 計算結果宣稱 fixture。公開財務快照及 neo 匯出 adapter 是後續階段。

## 架構

- 主 checkout 保留 upstream `main`，開發位於獨立 worktree `feat/neo-research-web`；基準 `b26f066331fc1ee11410acb576b19bd641a5e1ba`。
- `research.html` → `src/research/main.tsx` → `ResearchApp`，獨立 `vite.research.config.ts` 與輸出目錄 `dist-research/`。開發只綁 127.0.0.1:5174、strict port，沒有任何 API proxy；券商／admin 路由明確拒絕。
- 自有資料模型與 fixture 位於 `src/features/neo-research/`。查詢身分包含字串代號、交易日與 Asia/Taipei 的截止時間。選取結果只能包含截止前的 fixture rows；缺日／缺股保留缺資料狀態。
- `NeoResearchPanel` 只依賴研究 adapter；展示公司概覽、營收／季度資料、截至游標的 VWAP／POC、來源、版本、`decision_use=awareness_only` 及 `decision_eligible=false`。
- 研究版面採獨立儲存鍵，還原時只接受研究面板類型與有限數量、合法尺寸／位置；不讀 Pro 的交易版面或跨窗 channel。面板可釘選代號；全域日期／游標對所有面板一致。
- 公開原版入口另登記 `neo-research` 的 BlockType、BLOCK_META、BlockBody、PANEL_ICONS、靜態 preview 與 workspace-spec-v1 enum，以便在原版工作台加入同一元件。既有 panel 值不變。研究入口不 import 原版 App 或 PanelLibrary。

## 驗收

1. 原版 `pnpm test`、`pnpm build` 先建立未修改基線；完成後原版全套測試與建置、研究獨立 build 通過。
2. 模型測試驗代號／日期／截止、缺資料、abort；版面還原驗非法／交易面板及數量、尺寸限制。
3. 瀏覽器驗選股、釘選／恢復連動、跨日／游標、增刪面板、拖拉縮放與重新載入保存；舊 Pro localStorage、交易 query flags、B/S/Esc×2 不啟動交易。
4. 驗研究 dependency graph 排除 bootstrap、stream、shioaji、trading、trigger；攔查 fetch/XHR/SSE/WebSocket，正常操作零券商或 admin request，拒絕路由回 403/404。
5. 只保留本次研究 preview 的程序；不啟停 8788、21322、8080 或使用者其他服務。不發版、不 merge upstream。提交前完成獨立 diff review 與 secret scan。

## 網頁指引

已查 Modern Web Guidance `responsive-table`：使用 table/thead/tbody/th 語意；可捲表格具可聚焦且有名稱的 region，表頭在該捲動容器內 sticky。保留桌機窄面板的可讀捲動，不變更 Pro 原版瀏覽器相容政策。
