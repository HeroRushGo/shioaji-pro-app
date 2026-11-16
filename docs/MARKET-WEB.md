# 本機 Pro Web 行情與 Neo 財務

這是完整公開 Pro 工作區的本機行情模式。可用自選清單、報價、K 線、指標、五檔、成交明細及 Neo 研究；交易、帳戶、CA 與策略執行不開放。私有桌面 AI 模組不在公開 fork 內。

## 啟動與停止

需求：macOS arm64、Node 22.12 以上、已安裝鎖定前端依賴，以及同一 Trading vault 的 neo-client venv、已通過 receipt 驗證的 workstation Shioaji 行情金鑰。不要在專案建立 `.env` 或貼入金鑰。

在本次開發 worktree 執行（保留終端）：

```sh
cd ~/Documents/Trading/scripts/shioaji-pro-web.wt/full-market
pnpm dev:market
```

開啟 <http://127.0.0.1:5173/>。終端顯示 URL 前，會驗證官方 binary、receipt、後端版本、正式行情模式及真實 2330 合約查詢。停止時在該終端按 Ctrl-C；只回收本次啟動的三個程序群組。已有服務占用 5173、21323 或 21324 時會拒絕啟動，絕不接手或改用其他埠。不得以此腳本管理正式 21322、8080 或 neo-dash 8788。

服務關係：5173 完整 Pro → 21323 行情閘道 → 21324 帶 Bearer 驗證的 Shioaji 1.7.11。API 金鑰只在後端程序記憶體／必要的 SDK 子程序環境，不交給 Vite 或瀏覽器。原始 CLI 的 UDS 停用。行情模式的 API/SSE 固定同源，不採用舊 localStorage 的服務位址；dev/preview 皆 strictPort。

官方 binary 放在忽略版控的 `src-tauri/binaries/shioaji-aarch64-apple-darwin`。此次從 [官方 v1.7.11 release](https://github.com/Sinotrade/Shioaji/releases/tag/v1.7.11) 取得 `shioaji-v1.7.11-macOS-aarch64.tar.gz`，archive SHA256 為 `f5d845b0480a0b9d0c97657b278c098006f678ce6df1734a68b26d47a8deaa7f`；驗證 archive 及唯一普通檔案 `shioaji` 後解出，binary SHA256 為 `52907491366170a430991e3b6701a21718263a04b48b71649de0e4961bcb5b92`。launcher 會再次驗 binary hash 及 `SHIOAJI_VERSION`；更新任一 pin 必須重新審閱，不自動下載 latest。

## 真實財務與資料時間

Neo 面板從唯讀 `/research-data/` 取得本機核准發布、SHA256 驗證過的公開財務與 neo 歷史重播。內嵌面板明確選 `real/latest`；目前有 2330、2377、6488、2891，其他商品顯示缺資料，不補示範數字。財務頁保留月份、季別、EPS 口徑、首次留存與來源；財務最新版本和 2026-11-13 的重播時點分開標示。它不讀 SDK 財務或 DuckDB，不把今天取得的資料當成過去已知資料。

`.research-data` 不進版控。此次從 base `728bf5d72fefe207e23a93ac45cad07ad669e0c7` 的本機 main checkout 複製已驗 JSON，保留原始 bytes 與 firstSeenAt。更新時使用既有 `research:finance`／`research:neo` publisher 的核准流程；不可直接編改 payload。一般 `pnpm dev` 與完整 build/preview 也能提供已發布資料；獨立 research 入口的限制不變。

行情模式第一次開啟採獨立的研究版面；版面與 profiles 使用 market 專屬 localStorage keys。自選清單由閘道儲存在受保護的 `~/.trading/vendor-logs/pro-web-state/watchlists.json`，不轉送 SDK，也不改原始 Pro 的清單。可以在 UI 新增研究股票或其他行情商品。

## 維運與驗收界線

所有 SDK/stdout log 經 Trading 的 `ops/workstation-vendor-run.zsh` 落在既有 `~/.trading/vendor-logs/log/`，700 目錄、600 檔案、umask 077，沿用該 root 的 Time Machine 排除。不要把原始 log、token、帳戶或環境內容貼到 issue。日常不需開啟 log；檢查畫面 LIVE、快照時間及 Neo 的來源即可。

本機觀察到 pinned CLI 重啟重用 token 時曾出現 health=healthy、實際行情卻回 SessionNotEstablished。因此每次啟動使用新建的私有 SDK home，並在停止時只刪除本次自己建立的 session 目錄；自選資料獨立保留。這是本機已驗的隔離措施，不宣稱 health 本身能證明行情可查。SDK 各 session 不使用原有 `~/.shioaji`。

驗收包括真實 2330 合約／快照／歷史 K 線、新 SSE heartbeat、內嵌 Neo 真實財務、來源與 unsupported 商品清空、原始 CLI 未驗證請求 401、閘道帳戶請求 403，以及資料 filesystem aliases 無法繞過撤回守門。交易路由拒絕僅以 fake upstream 測試，沒有對真實券商送出交易請求。休市／盤外僅能證明連線與最後快照；股票新成交推播仍須開盤後另驗。

完整自動驗證命令：`pnpm test`、`pnpm build`、`pnpm build:research`、`pnpm test:research-boundary`、`pnpm test:research-data`、`node --test scripts/market-gateway.node-test.mjs`，以及使用 neo-client venv 執行 `scripts/test_run_market.py`。HTTP 測試需允許 loopback bind。最終測試、cold review 與執行版本記在本機 acceptance receipt；本分支不包含 Actions 啟用、merge、release 或 ops 部署。
