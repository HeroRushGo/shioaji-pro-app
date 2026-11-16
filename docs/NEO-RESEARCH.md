# Neo 研究工作台 — 本機 Pro Web fork

這是 C 路線的第一階段：公開 Pro Web fork 上的研究面板與獨立觀察入口。所有價格、VWAP／POC、營收與財報均為合成示範資料；尚未接入公開財務快照或 neo 真實重播。

## 啟動

在本功能分支的 checkout／worktree 執行：

```sh
pnpm install --frozen-lockfile
pnpm dev:research
```

開啟 `http://127.0.0.1:5174/research.html`。預設兩個可拖拉、縮放的研究面板，一個跟隨選股，一個鎖定 2891 供比較。點標題列的「連動／鎖定」切換狀態；右上角可新增面板，最多六個。版面儲存在此瀏覽器的 `neo-pro-research-workspace-v1`，儲存失敗時仍可使用並提示本次變更未儲存；重載可能回到上一次成功儲存的版面。

互動與還原共用大小限制（寬 4–12 欄、高 10–30 列），重載保留各面板的位置與大小。

頁面預留捲軸空間，避免增刪面板使捲軸出現／消失時改變欄寬；舊瀏覽器以固定垂直捲軸退回。桌面驗收範圍為 1100px 以上。

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

原版入口核對完整合約的地區、商品類型、交易所與代號：只接受與 fixture 相符的 `TW/STK/TSE` 或 `TW/STK/OTC` 已知普通股票。跨市場、期貨、同碼不同交易所、缺少身分或組合商品會立即顯示缺資料；獨立研究清單本身則已限定這些商品。

行情身分也包含 `target_code || code`；非空且指向其他代號的 `target_code` 不會借用主代號的 fixture。鎖定欄提交非法四碼代號時會還原實際鎖定值。

## 資料與網路界線

研究入口不經原版 main／App／bootstrap；沒有券商、帳務、下單、SSE 或外部資料連線。開發伺服器沒有 API proxy，`/api`、`/admin`、`/stream`、`/apps` 與原版 HTML 入口回 403。研究 build 有來源模組 allowlist，誤帶入未審閱的 shared 模組會失敗，並輸出 `dist-research/research-build.json`。這些是本原型的工程界線，不是對任意外掛程式碼的沙箱保證。

未知書籤回 404，不套用原版首頁 fallback。來源路徑檢查先正規化分隔符；建置收據必須包含研究入口與面板，不能以空清單成功。

開發站只提供 `/` 與 `/research.html` 的文件導航，原版 `dist/` 文件／別名也拒絕。來源檢查涵蓋整個專案的第一方檔案（含 `src/` 外），套件依賴與 Vite 虛擬模組另行辨識。

未來真實資料 adapter 應另行完成版本、期別、單位、first_seen／as_of 與來源權利驗證，再接公開財務快照或 neo 明列欄位的唯讀匯出。瀏覽器不直接開 DuckDB、不重算另一套 VWAP／POC、不代理任意 URL。既有 neo-client／8788 與 /score 管線不屬於本次變更。

## 驗證

```sh
pnpm test
pnpm test:research-boundary
pnpm build
pnpm build:research
pnpm preview:research
```

完整單元測試含本機 HTTP server 測試，需允許 loopback listener。`build:research` 只輸出研究頁至 `dist-research/`，preview 位於 127.0.0.1:5175。開發模式僅有 Vite 的同源 HMR WebSocket；production preview 的 CSP 禁止 connect。

驗收內容：查詢格式／缺資料／截止前綴／取消、研究版面 allowlist／尺寸上限／還原；瀏覽器驗選股、鎖定、切日與游標、增刪面板、拖拉縮放、重載，及券商／admin 路由拒絕與網路嘗試。原版測試與建置仍須通過。

`scripts/research-browser-qa.mjs` 匯出接受 Playwright `page` 的測試函式；由既有 Playwright 環境呼叫 `await run(page)`，自行建立／關閉隔離 context，不改使用者正在看的研究頁。須先起 5174 開發頁，瀏覽器測試不屬於一般 Vitest 套件，無新增 Playwright 依賴。

瀏覽器驗收同時核對儲存值與實際 DOM 位置／尺寸，並跨導覽累積網路及交易快捷鍵事件。`test:research-boundary` 暫建無副作用的專案本地模組、注入研究入口，要求真實 Vite build 拒絕此未審閱的 `src/` 外 import；完成後清掉自己的 probe，不改應用程式來源。

## Fork 版面規格

原版工作台匯出含研究面板的版面時，`get_workspace_spec.schema` 使用 fork 專屬識別碼 `urn:herorushgo:shioaji-pro-app:workspace-spec:neo-research:v1`；規格內容為本 repo 的 `schemas/workspace-spec-v1.schema.json`。這個 URN 是驗證器 registry 的名稱，不表示已部署可下載的遠端 schema 服務。

固定上游 `b26f0663` 的規格保留於 `schemas/upstream-workspace-spec-v1.schema.json`，兩個識別碼不同。開發期 Ajv2020 測試在同一個 consumer 同時登記兩份 schema：研究面板只通過 fork，既有上游版面兩者皆有效。Ajv 僅為測試依賴，不進研究頁 bundle。後續再擴充規格時，應更新 fork schema 版本與識別碼，避免相同 ID 對應不同規格。

## Git 與維護

自有遠端 `origin`：`https://github.com/HeroRushGo/shioaji-pro-app`；官方 `upstream`：`https://github.com/Sinotrade/shioaji-pro-app`。本次基準 `b26f066331fc1ee11410acb576b19bd641a5e1ba`，功能分支 `feat/neo-research-web`。主 checkout 保持 main 乾淨，功能在 worktree 開發。

後續透過功能分支與 PR 更新，不向官方 main 直推、不在此 fork 發布官方桌面 release。保留原始 AGPL-3.0-only 與作者聲明；分發、遠端互動或閉源交付另依實際方式處理相應授權。
