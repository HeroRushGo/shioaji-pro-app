# C 路線：真實財務與 neo 唯讀重播

本階段在獨立研究頁接入兩個獨立資料集，不改 neo-client、不重啟 8788、不登入券商。財務先以固定 Sinotrade/shioaji-data commit materialize；重播其後使用現有 neo 因果前綴讀端匯出。所有匯出維持 observation-only、decision_eligible=false，不把前端當成即時決策主源。

## 交付方式

- 在 `codex/research-real-data`（基於已審第一階段 b7b2968c）的既有 worktree 開發；保留原型 PR #1，不自行 merge。跨 repo 資料契約按 T3，另附操作與 acceptance。
- Node 22 的手動 CLI 將核准欄位寫入 gitignored `.research-data/`；原始混合研究文字只在記憶體驗 hash、取官方欄位。瀏覽器只讀 `/research-data/catalog.json` 及列名的 immutable JSON，無任意 URL proxy、無 SDK/DB/8788 直連。
- finance/replay 的 release 各自獨立，catalog 由排他 writer lock、完整 staging、原子 rename 發布；舊 release 永不改寫，失敗保留原 catalog。重跑同源同內容保留首次成功取得時間。catalog 含撤回 ID，所有歷史查詢與手動回退均套用撤回；離線僅代表截至本機最後同步的狀態。
- Vite dev 和 preview 同一讀取邊界；build 僅複製 catalog 及其列名的驗 hash 資料，不能複製整個資料目錄、上游原始檔或 store。CSP connect-src 只開同源（dev另有既有HMR），禁止原版/admin文件導航維持。
- 撤回紀錄持久存於獨立 `withdrawals.json`，不屬於可回退的catalog；只單調累加，未知上游撤回另外封鎖該dataset的後續發布，須人工核對才能恢復。已有catalog但ledger缺失/損壞/不可讀時拒絕服務；發布先寫ledger再切catalog。服務啟動與每次讀取均套用ledger，包含直接舊 URL，不只依賴 UI 選版。preview 在已打包清單上再疊本機最新撤回，catalog回退及服務重啟均不可復活舊檔。build攜帶ledger但不複製撤回payload。已下載或未再同步的離線副本無法追溯撤回，須停止提供或重建；不宣稱對純靜態離線副本能即時撤回。`/@fs`、`.research-data` 路徑直讀均拒絕，瀏覽器只走核准同源讀取介面。

## 本機資料契約 v1

`catalog.json`：`{schemaVersion:1, updatedAt, revoked: string[], financeReleases: FinanceRelease[], replayReleases: ReplayRelease[]}`。

兩種 release 均有 `id`、`firstSeenAt`、`items`；item 均有字串 `symbol`、`name`、`market: TSE|OTC`、`path: releases/<id>/<filename>.json`、`sha256`。財務 release 另有 `upstreamCommit`、`upstreamBuiltAt`；重播 release 另有 `neoCommit`，重播 item 另有 `date`。ID/filename 僅允許英數、短橫線/底線，路徑不接受外部 URL/跳脫/符號連結。

財務 payload：`{schemaVersion:1, kind:'finance', releaseId, symbol,name,market,firstSeenAt,upstreamBuiltAt,provenance,revenue,quarters}`。`revenue=[{period:YYYY-MM,revenueThousands:number|null,yoyPercent:number|null}]`；`quarters=[{period:YYYYQn,eps:number|null,grossMarginPercent:number|null,epsBasis:string}]`。provenance 有 `upstreamCommit,sourceSchema,sourceSha256,manifestSha256,sourceUrl,sources:[{id,name,url,licenseUrl,attribution}]`；不保存題材、供應鏈、研究摘要/AI文字。金融格式不適用的毛利率保留 null。

EPS 取上游 `income_quarter`，basis 只允許 `quarter_reported_q1`（第一季公告值）或 `quarter_derived_from_ytd`（同年累計相減的推算單季）；不能把公告累計 EPS 當 Q2/Q3 單季。一般業單季毛利率採同季毛利／同季營收×100，不能相減兩季累計比例；缺分母／不適用則 null。金額千元、EPS元、比率百分比，逐欄 provenance 記來源與公式。

重播 payload：`{schemaVersion:1,kind:'replay',releaseId,symbol,name,market,date,firstSeenAt,neoCommit,samplingMinutes,provenance,points}`；`points=[{time:HH:mm,price:number|null,vwap:number|null,poc:number|null}]`。每個點必須是其 HH:mm:00+08:00 的 neo 前綴結果；POC 不能使用全日結果。provenance 保留確切本機讀端、輸出時間、來源/覆蓋/資格資訊與已核對版本，不包含帳務、憑證、原始逐筆或五檔。匯出只限過去交易日；資料缺漏保持空，不查SDK補齊。

neo 使用隔離離線 reader 的三個既有 GET，不開 listener：session、bars(as_of=HH:mm:00)、VP(as_of=HH:mm:00)，預設30分鐘採樣。逐分鐘 developing 的時間是桶首但包含整分鐘，不作精確時點讀數。執行前後驗 clean neo HEAD、實際 import 路徑與程式 fingerprint，DB 的 realpath／inode／size／mtime_ns／ctime_ns 前後不變；session來源資訊前後一致。任一來源變動整份拒收。所有DuckDB開啟 read_only，外連雙重tripwire，不安裝依賴、不修改neo碼、不長持鎖干擾既有寫者。

## 查詢與時間

ResearchQuery 保留 symbol/date/cutoff，新增 `sourceMode: real|fixture`、`financeMode: latest|as_of`（可選欄位的舊呼叫維持 fixture 兼容）。fresh workspace 用 real/latest，舊 v1 workspace 遷移為 fixture，避免舊版面忽然改讀真值；可明確切換。

最新財務與歷史重播有不同時間軸。latest 顯示目前可用版本、各股營收月/財報季及本機 firstSeenAt，明示不是當時已知資料。as_of 僅接受 firstSeenAt<=重播截止的合格快照，尚未留存則空。replay 只選同股/同市場/同日版本、只呈現<=游標的點，明示採樣間隔與實際最後時點。

ResearchSnapshot 保留頂層 revenue/quarters/replay 陣列，另有 `finance`、`replayInfo` 獨立 metadata（status/source/releaseId/firstSeenAt/notice/provenance）。錯 hash/schema/query/未來點須拒收，兩資料區塊可部分成功；真值缺資料永不 fallback fixture。瀏覽器請求有 AbortSignal，query key 含來源與財務模式；晚回應不得串股、跨日期或來源。

## 驗收與回退

- 真實來源 bytes SHA 對 manifest；上市/上櫃/金融股/缺股，至少一個月營收與一季科目對官方原表核數與單位。
- materializer 測 hash錯/major錯/斷網/部分下載/競爭/同內容重跑與首次取得/撤回後讀舊版。neo 逐值與既有讀端相同，盤前空、游標前綴、缺資料不補寫。
- Browser 驗 real/fixture明示、latest/as_of、快速換股換日、重播採樣截止、部分成功與舊版面遷移；保留幾何/釘選/重載/交易快捷鍵隔離。正常 fetch 只准固定同源 JSON，零券商/admin/SSE/外部連線。
- 全套 Vitest、Node materializer測試、原版/研究build、實際import負例、dev/preview禁止路由與資料檔路徑反例，secret scan及獨立唯讀終審；交付精確HEAD與clean非partial收據。
- 回退可關閉研究頁、切回前版分支，原始 neo服務與store均不需還原。只回退核准未撤回的本機資料 release，不把撤回資料重新暴露。

## 檔案範圍與不動清單

只動研究 model/provider/panel與contract adapter、ResearchApp/workspace/CSS、獨立Vite設定與boundary、`scripts/research-data/` 的store/finance/neo/窄讀取middleware及測試、package script/gitignore、研究文檔與驗收腳本。原版App/proxy/bootstrap/交易與SDK模組、neo-client原始碼與資料庫/schema、正式服務/launchd/deploy、vault generated paths皆不動。桌面驗收≥1100px；原版完整Vitest/build驗byte與行為不回歸。
