# Neo 研究工作台 — 本機 Pro Web fork

C 路線已進入真實資料階段：獨立研究頁可讀本機核准的公開財務快照與 neo 唯讀重播匯出。新工作台預設「真實快照／最新可用財務」，也可明確切換到「示範資料」；只有示範模式中的數字是合成 fixture，兩種來源不互相補位。

當前設計與資料契約見 [真實財務與 neo 唯讀重播](design/research-real-data.md)；[第一階段設計](design/neo-research-web.md) 保留原型的歷史範圍與驗收。這是 observation-only 研究工具，維持 `awareness_only`、`decision_eligible=false`，不作即時決策主源。

## 啟動與使用

在本功能分支的 checkout／worktree 執行：

```sh
pnpm install --frozen-lockfile
pnpm dev:research
```

開啟 `http://127.0.0.1:5174/research.html`。5174 被占用時拒絕啟動，不自動換埠；停止用 Ctrl+C。官方 `pnpm dev` 仍是原版交易入口，研究工作使用 `dev:research`。基線工具鏈為 Node 22.23.5、pnpm 10.34.9，`.nvmrc` 指定 Node；也可不改全域工具鏈而啟動：

```sh
npm exec --yes --package=node@22.23.5 --package=pnpm@10.34.9 -- pnpm dev:research
```

- 「資料」選真實快照或示範資料。「財務」選最新可用或跟隨重播時點；示範模式明示合成資料，不代表公告歷史。
- 「重播日期」可輸入合法日期，可用日期提示來自本機目錄；「重播截至」是 Asia/Taipei 時間。日期可輸入不代表該日已匯入，缺資料會保留空區塊。
- 財務與重播各自顯示可用、缺資料、未留存、驗證失敗或撤回狀態。一個資料集缺少，不會遮掉另一個已驗資料集；真值缺少永不改填 fixture。
- 預設兩個可拖拉、縮放的研究面板，一個跟隨選股，一個鎖定 2891。標題列可切換連動／鎖定，最多六個面板；概覽、財務、重播、來源四頁可分別查看資料與出處。

版面仍使用此瀏覽器的 `neo-pro-research-workspace-v1` 儲存鍵，內容 schema 已升為 version 2。舊 version 1 版面會遷移成 fixture/as_of，保留選股、鎖定、日期與幾何，不會突然改讀真值。儲存失敗提示「本次版面變更未儲存」；重載可能還原上一次成功儲存的版面。

互動與還原共用寬 4–12 欄、高 10–30 列限制。頁面保留捲軸空間，舊瀏覽器以固定垂直捲軸退回，避免增刪面板改變欄寬；桌面驗收範圍為 1100px 以上。

## 真實財務與歷史重播有兩個時點

**最新可用財務**表示目前本機保留的合格版本，並不保證已涵蓋最新公告，也不代表重播當時已知。畫面分別標示營收月份、財報季別、版本及首次成功留存時間 `firstSeenAt`。重播日期改到過去時，latest 財務仍明示與重播時點不同。

**跟隨重播時點**只選 `firstSeenAt <= 重播截止` 的合格財務快照；此前沒有留存就顯示「當時版本未留存」。今天下載到的歷史財報，不能回填成過去已知資料。來源 release 的建置時間、公告期別與本機首次留存時間是不同欄位。相同來源／相同內容重跑不重設首次留存時間。

**neo 重播**只呈現同股、同市場、同交易日且不晚於游標的已匯出樣本，顯示採樣間隔與實際最後時點。驗收匯出使用 30 分鐘採樣，例如游標 10:07 只會看到最近的 10:00 樣本，不會讀進 10:30，也不宣稱已重算精確 10:07 的結果。盤前及缺值保持空，圖線遇 null 中斷。價格、VWAP、POC 直接採 neo 既有精確截止讀端的輸出，此頁不重算另一套 VWAP／POC。

### 驗收時執行的資料匯入與核對

- 財務：四股 2330／2377／6488／2891，固定 `Sinotrade/shioaji-data` commit `526c518249a3c5bdaa74d63684c0358db7c248e6`，上游 release `2026.11.13.2328`。以 manifest 的 SHA-256 驗證來源 bytes，再產生核准 projection。來源版本有資料不等於每股每期齊備。
- 該版 2330／6488 的來源檔包含 2026-10 營收及 2026Q3 財報；2891 仍僅到 2026-09／2026Q2，不能因 release 日期較新便改標成 10 月或 Q3。
- 官方原表抽核範圍為 2330／6488 的 2026-10 月營收，以及 2026Q3 公告累計營收與 EPS，單位及數字相符；這項抽核不代表所有歷史欄位都經官方逐筆核對。
- 單季 EPS 另比對上游 `income_quarter` 與同年 `income_ytd` 差分；第一季標「第一季公告值」，第二至四季標「單季，累計相減推算」。一般業單季毛利率為同季毛利／同季營收 ×100，不能相減兩季累計毛利率；缺值、金融業不適用項目維持 null。
- neo：四股的 **2026-11-13**，30 分鐘精確截止採樣；當時核對的 clean neo HEAD 為 `560a7eef386c19981a5f60ffa8560acda427ca03`。本文件不宣稱其他日期已匯入。

金融股另以 MOPS 115 年 9 月歷史營收表核對中信金 21,331,939 千元，數值一致。官方口徑註明金控營業收入為認列所有子公司損益之合計，與一般業營收不同，面板在財務時點旁保留此註記。Q2 EPS 僅核對上游 YTD 差分，沒有宣稱獨立核對官方同季 EPS 原報。

本機核對紀錄為 `/private/tmp/shioaji-pro-real-data/source-check/verification.json`、`projection-check.json` 與 `banking-check.json`，屬驗收產物，未納入 Git。最終程式 HEAD、測試數量與瀏覽器結果以本輪交付收據為準。

## 手動匯入真實資料

兩支 CLI 都只由使用者手動執行，沒有安裝排程。`.research-data/` 是本機生成且 gitignored 的資料根目錄；原始混合研究文字、資料庫、憑證及 materialized payload 不進 Git。首次匯入前沒有資料時，真實模式會顯示缺資料，仍可明確選取示範模式使用原型。

### 公開財務

在 Web repo 執行：

```sh
pnpm research:finance
```

可指定固定來源與範圍，重現本次核對版本：

```sh
pnpm research:finance \
  --commit 526c518249a3c5bdaa74d63684c0358db7c248e6 \
  --symbols 2330,2377,6488,2891 \
  --root .research-data
```

`--commit`、`--symbols`、`--root` 可選；未指定 commit 時先解析官方 main，再固定同一 SHA 取 manifest／檔案。此 CLI 使用公開 HTTPS，不登入券商。保留核准的官方數值、來源與顯名資訊，不永久保存題材、供應鏈、AI 研究摘要或引文。月份與季別依各股內容顯示。

### neo 唯讀重播

先指向**已存在**的 neo-client checkout 與具備其依賴的 Python venv。以下範例的路徑應對應本機實際位置；若既有 venv 不在 `.venv/`，只替換 `NEO_RESEARCH_PYTHON`，不要為此安裝或更新 neo 依賴。

```sh
NEO_RESEARCH_NEO_REPO="$HOME/Documents/Trading/scripts/neo-client"
NEO_RESEARCH_PYTHON="$NEO_RESEARCH_NEO_REPO/.venv/bin/python"

pnpm research:neo \
  --root .research-data \
  --neo-repo "$NEO_RESEARCH_NEO_REPO" \
  --python "$NEO_RESEARCH_PYTHON" \
  --neo-commit 560a7eef386c19981a5f60ffa8560acda427ca03 \
  --dates 2026-11-13 \
  --symbols 2330,2377,6488,2891 \
  --sampling-minutes 30
```

`--neo-repo`、`--python` 必須為絕對路徑，指定 commit 必須符合該 checkout 的 clean HEAD。若 HEAD 已演進，先核對新版本相容性再更新 pin，不能為了讓指令通過而略過檢查。日期必須早於台北今天；請選既有資料涵蓋的過去交易日，沒有 ticks 的日期維持缺資料。CLI 代號目前限上述四個已核對商品身分。預設讀取既有 store A/B，缺少的來源不靠 SDK 補齊。

匯出以子程序中的隔離 ASGI reader 呼叫既有 session、bars(as_of=HH:mm:00)、VP(as_of=HH:mm:00) 三種窄 GET。**不啟動 reader listener、不連既有 8787／8788、不重啟 8788、不登入券商、不修改 neo 原始碼、不執行依賴安裝。** 所有 DuckDB 連線為 read_only；來源程式、DB/WAL 指紋及 session 來源前後核對，任一來源變動就拒收整份匯出。輸出只含核准衍生值及來源／覆蓋資訊，不含帳務、原始逐筆或五檔。

## 撤回、回退與離線範圍

finance/replay 各自以不可變 release 保存，完整 staging 驗證後才原子更新 catalog；失敗保留上一份合格 catalog。撤回另外持久寫入 `.research-data/withdrawals.json`，只單調累加，**不隨 catalog 回退或服務重啟而回退**。

- 已有 catalog 卻缺少、損壞或無法讀取 withdrawals ledger 時，讀取 fail-closed，不繼續服務舊資料。
- 未知上游撤回會封鎖相關 dataset 的後續發布，必須人工核對原因與權利狀態才能恢復；不要刪除 ledger、複製舊 catalog 或重新發布舊 release 來繞過封鎖。
- dev 每次讀取套用撤回集合，直接舊 payload URL 也不能繞過。preview 只服務已打包清單，再疊加本機最新撤回；build 帶 ledger，並不複製撤回 payload。
- 已下載的舊 build、或不再同步的純靜態離線副本，無法保證追溯撤回。得知撤回後應停止提供相關副本或重新建立合格 build，不能把本機 preview 的撤回機制宣稱成離線即時撤回。

## 資料與網路界線

研究入口不經原版 main／App／bootstrap，不啟動券商、帳務、下單、SSE 或遠端資料服務。瀏覽器只讀 `/research-data/catalog.json` 及 catalog 列名、通過 hash 的同源固定 JSON。dev 與 preview 共用窄讀取 middleware，不代理任意 URL，不直接讀 DuckDB，也不透過瀏覽器連 neo admin。

沒有 API proxy；`/api`、`/admin`、`/stream`、`/apps`、原版 HTML／建置目錄與別名拒絕，未知書籤回 404，不套用原版首頁 fallback。研究站只允許 `/`、`/research.html` 的文件導航；`.research-data`、`/@fs` 及非核准資料路徑不可直接讀取。

研究 build 檢查整個專案的第一方來源模組 allowlist（含 `src/` 外），未審閱模組使建置失敗；路徑先正規化，收據必含研究入口與面板，不能以空清單成功。輸出 `dist-research/research-build.json`。這是受審程式與路由的工程界線，不是任意外掛程式碼的沙箱保證。

`build:research` 只複製 catalog、ledger 及核准清單中的驗 hash projection；不整個複製資料根目錄、原始上游檔、store 或其他檔案。production preview 的 CSP 為 `connect-src 'self'`，以支援上述同源 JSON；dev 另允許精確本機 Vite HMR WebSocket。這已取代第一階段的零資料 fetch／`connect-src 'none'` 前提。

主工作台亦登記 `Neo 研究` 面板，但原版入口仍有正常行情與交易功能，不等同獨立研究頁。原版 adapter 保留完整 `TW/STK`、TSE／OTC、市場與已知代號的核對；同碼異市場、其他地區、缺少身分、combo 或非空且指向其他代號的 `target_code`，立即清空研究數值。獨立頁可輸入四碼，但實際顯示範圍仍以核准快照為準。

## 驗證

```sh
pnpm test
pnpm test:research-data
pnpm test:research-boundary
pnpm build
pnpm build:research
pnpm preview:research
```

Python helper 另有三項隔離測試（以 synthetic client／暫存假 store 驗證，不開真實市場 store），使用同一個既有 Python：

```sh
NEO_RESEARCH_NEO_REPO="$HOME/Documents/Trading/scripts/neo-client"
NEO_RESEARCH_PYTHON="$NEO_RESEARCH_NEO_REPO/.venv/bin/python"
"$NEO_RESEARCH_PYTHON" -P -B scripts/research-data/neo-export.test.py
```

完整 Vitest 包含本機 HTTP server 測試，需允許 loopback listener。`pnpm test:research-data` 執行 Node materializer／publisher 測試；`test:research-boundary` 暫建無副作用的 `src/` 外本地 probe，要求實際 Vite build 拒絕，完成後只移除自己的 probe。原版完整測試與建置仍須通過。

`build:research` 輸出 `dist-research/`，preview 位於 `127.0.0.1:5175`。瀏覽器驗收涵蓋真實／示範明示、latest/as_of、首次留存、部分成功、null／截止前綴、EPS 口徑、舊版面遷移、快速切股切日、釘選與幾何保存；同時核對 dev／preview 禁止路由、資料路徑與撤回行為。網路觀測允許核准同源 JSON，仍要求零券商／admin／SSE／外連。

`scripts/research-browser-qa.mjs` 保留原型互動回歸，`scripts/research-real-browser-qa.mjs` 驗真實資料模式；兩者由既有 Playwright 環境呼叫匯出的 `await run(page)`，建立及關閉自己的隔離 context，不操作使用者正在看的分頁，無新增 Playwright 依賴。幾何驗收同時核對儲存值與實際 DOM，並跨導覽累積網路與交易快捷鍵事件。

## Fork 版面規格與維護

原版 `get_workspace_spec.schema` 使用 fork 識別碼 `urn:herorushgo:shioaji-pro-app:workspace-spec:neo-research:v1`，對應 `schemas/workspace-spec-v1.schema.json`。URN 是驗證器 registry 名稱，不表示已部署可下載服務。上游 `b26f0663` 規格保留在 `schemas/upstream-workspace-spec-v1.schema.json`；同一 Ajv consumer 可登記兩份，研究面板只通過 fork，既有版面兩者皆有效。Ajv 僅作測試依賴。

自有遠端 `origin` 為 `https://github.com/HeroRushGo/shioaji-pro-app`，官方 `upstream` 為 `https://github.com/Sinotrade/shioaji-pro-app`。第一階段基準 `b26f066331fc1ee11410acb576b19bd641a5e1ba`、分支 `feat/neo-research-web`；真實資料階段在 `codex/research-real-data` 開發，保留既有原型 PR，不自行 merge。主 checkout 的 main 保持乾淨，後續仍走功能分支與 PR，不發布官方桌面 release。

保留 AGPL-3.0-only 與作者聲明；分發、遠端互動或閉源交付依實際方式處理相應授權。公開財務只保存已核准官方數值與來源顯名，不能把程式授權套用到尚待釐清的研究資料內容。
