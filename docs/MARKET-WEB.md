# 本機 Pro Web 行情與 Neo 財務

這是完整公開 Pro 工作區的本機行情模式。可用自選清單、報價、K 線、指標、五檔、成交明細及 Neo 研究；交易、帳戶、CA 與策略執行不開放。私有桌面 AI 模組不在公開 fork 內。

## 啟動與停止

需求：macOS arm64、Node 22.12 以上、已安裝鎖定前端依賴，以及同一 Trading vault 的 neo-client venv、已通過 receipt 驗證的 workstation Shioaji 行情金鑰。不要在專案建立 `.env` 或貼入金鑰。

建議使用按需 LaunchAgent `com.user.shioaji-pro-web`。首次從本功能來源 checkout 執行安裝：

```sh
/bin/zsh scripts/pro-web-ctl.zsh plan
/bin/zsh scripts/pro-web-ctl.zsh install
```

`install` 只登記 job，不會啟動服務。安裝器把管理程式的固定版本存到 `~/.trading/pro-web-control`，並建立 `~/.local/bin/pro-web-ctl`；即使從 worktree 安裝，服務仍使用 Git 主 checkout 的已合併 main。這項本機安裝不代表新功能分支已合併。

安裝後可在任意目錄操作；若 `~/.local/bin` 不在 PATH，改用 `~/.local/bin/pro-web-ctl` 完整路徑：

| 指令 | 行為 |
| --- | --- |
| `pro-web-ctl plan` | 顯示安裝與服務目標 |
| `pro-web-ctl start` | 啟動；已就緒時保留原程序 |
| `pro-web-ctl stop` | 送出正常停止訊號，等待三個服務收尾 |
| `pro-web-ctl restart` | 先停乾淨，再重新啟動 |
| `pro-web-ctl status` | 查看 job、服務埠與就緒狀態 |
| `pro-web-ctl log` | 查看專用 supervisor 日誌 |
| `pro-web-ctl uninstall` | 正常停止並移除已驗證的管理元件 |

開啟 <http://127.0.0.1:5173/>。啟動會驗證官方 binary、receipt、後端版本、正式行情模式及真實 2330 合約查詢。由 launchd 管理後，關閉呼叫它的終端機或 Codex 不會停止服務；以 `stop`／`restart` 管理，不靠關視窗停止。`RunAtLoad=false`、`KeepAlive=false`，沒有排程、登入自啟或故障自動重啟；登出或關機會結束這個使用者工作階段。

5173、21323、21324 若被其他程序占用，管理器會拒絕啟動，不會殺掉占用者、接手或換埠。不得以此工具管理正式 21322、8080 或 neo-dash 8788。來源、安裝與驗收契約見 [launchd 設計](design/pro-web-launchd.md)。

仍可使用前景模式；先停止 LaunchAgent，再從 main 執行並保留終端：

```sh
cd ~/Documents/Trading/scripts/shioaji-pro-web
/bin/zsh scripts/run-market.zsh
```

前景模式以 Ctrl-C 收尾，只回收本次啟動的程序群組。pnpm 10 也可用 `pnpm dev:market`；本機若裝 pnpm 11，直接用 zsh 命令可避免它在 run 前自動重建 pnpm 10 的 node_modules。

服務關係：5173 完整 Pro → 21323 行情閘道 → 21324 帶 Bearer 驗證的 Shioaji 1.7.11。API 金鑰只在後端程序記憶體／必要的 SDK 子程序環境，不交給 Vite 或瀏覽器。原始 CLI 的 UDS 停用。行情模式的 API/SSE 固定同源，不採用舊 localStorage 的服務位址；dev/preview 皆 strictPort。

官方 binary 放在忽略版控的 `src-tauri/binaries/shioaji-aarch64-apple-darwin`。此次從 [官方 v1.7.11 release](https://github.com/Sinotrade/Shioaji/releases/tag/v1.7.11) 取得 `shioaji-v1.7.11-macOS-aarch64.tar.gz`，archive SHA256 為 `f5d845b0480a0b9d0c97657b278c098006f678ce6df1734a68b26d47a8deaa7f`；驗證 archive 及唯一普通檔案 `shioaji` 後解出，binary SHA256 為 `52907491366170a430991e3b6701a21718263a04b48b71649de0e4961bcb5b92`。launcher 會再次驗 binary hash 及 `SHIOAJI_VERSION`；更新任一 pin 必須重新審閱，不自動下載 latest。

## 真實財務與資料時間

Neo 面板從唯讀 `/research-data/` 取得本機核准發布、SHA256 驗證過的公開財務與 neo 歷史重播。內嵌面板明確選 `real/latest`；目前有 2330、2377、6488、2891，其他商品顯示缺資料，不補示範數字。財務頁保留月份、季別、EPS 口徑、首次留存與來源；財務最新版本和 2026-11-13 的重播時點分開標示。它不讀 SDK 財務或 DuckDB，不把今天取得的資料當成過去已知資料。

`.research-data` 不進版控。此次從 base `728bf5d72fefe207e23a93ac45cad07ad669e0c7` 的本機 main checkout 複製已驗 JSON，保留原始 bytes 與 firstSeenAt。更新時使用既有 `research:finance`／`research:neo` publisher 的核准流程；不可直接編改 payload。一般 `pnpm dev` 與完整 build/preview 也能提供已發布資料；獨立 research 入口的限制不變。

行情模式第一次開啟採獨立的研究版面；版面與 profiles 使用 market 專屬 localStorage keys。自選清單由閘道儲存在受保護的 `~/.trading/vendor-logs/pro-web-state/watchlists.json`，不轉送 SDK，也不改原始 Pro 的清單。可以在 UI 新增研究股票或其他行情商品。

## 維運與驗收界線

所有 SDK/stdout log 經 Trading 的 `ops/workstation-vendor-run.zsh` 落在既有 `~/.trading/vendor-logs/log/`，700 目錄、600 檔案、umask 077，沿用該 root 的 Time Machine 排除。不要把原始 log、token、帳戶或環境內容貼到 issue。日常不需開啟 log；檢查畫面 LIVE、快照時間及 Neo 的來源即可。

LaunchAgent 的 plist 只存公開路徑與執行環境，不存金鑰、CA 或登入 token；啟動以 `env -i` 清空繼承環境，搭配私有 `ZDOTDIR` 隔開使用者 shell 啟動檔，憑證仍由既有 receipt loader 取得。`pro-web-ctl log` 只顯示 supervisor 日誌，不會輸出 SDK／後端日誌。卸載管理器會保留自選清單、研究資料與後端日誌。

本機觀察到 pinned CLI 重啟重用 token 時曾出現 health=healthy、實際行情卻回 SessionNotEstablished。因此每次啟動使用新建的私有 SDK home，並在停止時只刪除本次自己建立的 session 目錄；自選資料獨立保留。這是本機已驗的隔離措施，不宣稱 health 本身能證明行情可查。SDK 各 session 不使用原有 `~/.shioaji`。

驗收包括真實 2330 合約／快照／歷史 K 線、新 SSE heartbeat、內嵌 Neo 真實財務、來源與 unsupported 商品清空、原始 CLI 未驗證請求 401、閘道帳戶請求 403，以及資料 filesystem aliases 無法繞過撤回守門。交易路由拒絕僅以 fake upstream 測試，沒有對真實券商送出交易請求。休市／盤外僅能證明連線與最後快照；股票新成交推播仍須開盤後另驗。

完整自動驗證命令：`pnpm test`、`pnpm build`、`pnpm build:research`、`pnpm test:research-boundary`、`pnpm test:research-data`、`node --test scripts/market-gateway.node-test.mjs`，以及使用 neo-client venv 執行 `scripts/test_run_market.py`、`scripts/test_pro_web_ctl.py`、`scripts/test_pro_web_launchd.py`。HTTP 測試需允許 loopback bind。launchd 實機驗收另須確認：呼叫程序退出後仍就緒、常駐外層 shell（launchd job PID）的 PPID 為 1 且 Python supervisor 是其子程序、重複 start 不換 PID、stop 後三埠釋放且保持 idle，以及重新啟動後的新 heartbeat 與 Neo 財務。最終結果及版本以本機 acceptance receipt 為準；本次不啟用 Actions，也不自行合併新 PR、發版或部署 ops。
