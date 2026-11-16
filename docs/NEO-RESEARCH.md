# Neo 研究工作台 — 本機 Pro Web fork

這是 C 路線的第一階段：公開 Pro Web fork 上的研究面板與獨立觀察入口。所有價格、VWAP／POC、營收與財報均為合成示範資料；尚未接入公開財務快照或 neo 真實重播。

## 啟動

在本功能分支的 checkout／worktree 執行：

```sh
pnpm install --frozen-lockfile
pnpm dev:research
```

開啟 `http://127.0.0.1:5174/research.html`。預設兩個可拖拉、縮放的研究面板，一個跟隨選股，一個鎖定 2891 供比較。點標題列的「連動／鎖定」切換狀態；右上角可新增面板，最多六個。版面儲存在此瀏覽器的 `neo-pro-research-workspace-v1`，儲存被禁止時仍可使用並提示重載不保留。

互動與還原共用大小限制（寬 4–12 欄、高 10–30 列），重載保留各面板的位置與大小。

基線工具鏈為 Node 22.23.5、pnpm 10.34.9；`.nvmrc` 指定 Node。也可不改全域工具鏈而啟動：

```sh
npm exec --yes --package=node@22.23.5 --package=pnpm@10.34.9 -- pnpm dev:research
```

停止開發頁用 Ctrl+C。5174 被占用時會拒絕啟動，不自動換埠。官方 `pnpm dev` 仍是原版交易入口；研究工作請使用 `dev:research`。

## 本階段能做什麼

- 2330／2377／6488／2891 選股連動、釘選與比較；其他四碼代號顯示缺資料。
- 概覽／財務／重播／來源四頁，表格保留營收千元、EPS 元與金融業不適用欄位。
- 2026-11-12／2026-11-13 兩個合成交易日；截止游標只顯示之前的示範讀數。盤前保留空圖，不以全日結果填入。
- 每筆切面帶查詢代號、日期、台北截止、fixture 版本與觀察資格。切股、切日、切游標時不顯示前次查詢的數值。
- 主工作台亦登記 `Neo 研究` 面板。原版工作台仍有其正常行情與交易功能，不等同獨立研究頁。

## 資料與網路界線

研究入口不經原版 main／App／bootstrap；沒有券商、帳務、下單、SSE 或外部資料連線。開發伺服器沒有 API proxy，`/api`、`/admin`、`/stream`、`/apps` 與原版 HTML 入口回 403。研究 build 有來源模組 allowlist，誤帶入未審閱的 shared 模組會失敗，並輸出 `dist-research/research-build.json`。這些是本原型的工程界線，不是對任意外掛程式碼的沙箱保證。

未知書籤回 404，不套用原版首頁 fallback。來源路徑檢查先正規化分隔符；建置收據必須包含研究入口與面板，不能以空清單成功。

未來真實資料 adapter 應另行完成版本、期別、單位、first_seen／as_of 與來源權利驗證，再接公開財務快照或 neo 明列欄位的唯讀匯出。瀏覽器不直接開 DuckDB、不重算另一套 VWAP／POC、不代理任意 URL。既有 neo-client／8788 與 /score 管線不屬於本次變更。

## 驗證

```sh
pnpm test
pnpm build
pnpm build:research
pnpm preview:research
```

完整單元測試含本機 HTTP server 測試，需允許 loopback listener。`build:research` 只輸出研究頁至 `dist-research/`，preview 位於 127.0.0.1:5175。開發模式僅有 Vite 的同源 HMR WebSocket；production preview 的 CSP 禁止 connect。

驗收內容：查詢格式／缺資料／截止前綴／取消、研究版面 allowlist／尺寸上限／還原；瀏覽器驗選股、鎖定、切日與游標、增刪面板、拖拉縮放、重載，及券商／admin 路由拒絕與網路嘗試。原版測試與建置仍須通過。

`scripts/research-browser-qa.mjs` 匯出接受 Playwright `page` 的測試函式；由既有 Playwright 環境呼叫 `await run(page)`，自行建立／關閉隔離 context，不改使用者正在看的研究頁。須先起 5174 開發頁，瀏覽器測試不屬於一般 Vitest 套件，無新增 Playwright 依賴。

## Git 與維護

自有遠端 `origin`：`https://github.com/HeroRushGo/shioaji-pro-app`；官方 `upstream`：`https://github.com/Sinotrade/shioaji-pro-app`。本次基準 `b26f066331fc1ee11410acb576b19bd641a5e1ba`，功能分支 `feat/neo-research-web`。主 checkout 保持 main 乾淨，功能在 worktree 開發。

後續透過功能分支與 PR 更新，不向官方 main 直推、不在此 fork 發布官方桌面 release。保留原始 AGPL-3.0-only 與作者聲明；分發、遠端互動或閉源交付另依實際方式處理相應授權。
