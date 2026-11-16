export default async (page) => {
 const context=await page.context().browser().newContext({viewport:{width:1440,height:1100}}), qa=await context.newPage();
 const errors=[],checks=[],requests=[];qa.on('pageerror',e=>errors.push(String(e)));context.on('request',r=>requests.push(r.url()));
 await context.addInitScript(()=>{window.__researchCalls=[];const rec=(kind,url)=>window.__researchCalls.push({kind,url:String(url)});const f=fetch;window.fetch=function(...a){rec('fetch',a[0]?.url??a[0]);return f.apply(this,a)};const o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...a){rec('xhr',u);return o.call(this,m,u,...a)};for(const k of ['WebSocket','EventSource'])window[k]=new Proxy(window[k],{construct(t,a){rec(k,a[0]);return Reflect.construct(t,a)}})});
 const assert=(v,m)=>{if(!v)throw Error(m)},panels=()=>qa.locator('.research-panel'),first=()=>panels().first();
 try{
 await qa.goto('http://127.0.0.1:5174/research.html?popout=ticket&mockPendingConfirm&condDemo');await qa.locator('.nr-entity').first().waitFor();assert(await panels().count()===2,'default panels');checks.push('trading query flags ignored');
 await qa.getByRole('button',{name:/2377 上市 微星/}).click();await first().getByText('2377 · 2026-11-13').waitFor();assert((await panels().nth(1).innerText()).includes('2891 ·'),'pinned second panel');
 await first().getByTitle('跟隨自選清單選擇；點擊鎖定目前商品').click();await qa.getByRole('button',{name:/6488 上櫃 環球晶/}).click();assert((await first().innerText()).includes('2377 ·'),'pin follows wrong symbol');
 await first().getByTitle('已鎖定；點擊恢復連動').click();await first().getByText('6488 · 2026-11-13').waitFor();checks.push('selection and pin/unpin');
 await qa.getByLabel('截至時間',{exact:true}).fill('10:00');await first().getByRole('button',{name:'重播',exact:true}).click();await qa.waitForFunction(()=>document.querySelector('.research-panel table tbody tr'));
 const times=await first().locator('tbody th').allTextContents();assert(times.length&&times.every(t=>t<='10:00'),'future replay rows');checks.push('causal cursor prefix');
 await qa.getByLabel('交易日',{exact:true}).selectOption('2026-11-12');await first().getByText('6488 · 2026-11-12').waitFor();await panels().nth(1).getByRole('button',{name:'財務',exact:true}).click();await panels().nth(1).getByRole('region',{name:'示範季度財報表，可水平與垂直捲動'}).waitFor();checks.push('date and financial table');
 const before=await qa.evaluate(()=>localStorage.getItem('neo-pro-research-workspace-v1'));const header=await first().locator('.drag-handle').boundingBox();
 await qa.mouse.move(header.x+80,header.y+20);await qa.mouse.down();await qa.mouse.move(header.x+680,header.y+20,{steps:18});await qa.mouse.up();
 await qa.waitForFunction(old=>localStorage.getItem('neo-pro-research-workspace-v1')!==old,before);checks.push('drag persists geometry');
 await first().scrollIntoViewIfNeeded();const handle=await first().locator('.react-resizable-handle').boundingBox();const old=await qa.evaluate(()=>JSON.parse(localStorage.getItem('neo-pro-research-workspace-v1')).layout[0].h);
 await qa.mouse.move(handle.x+12,handle.y+12);await qa.mouse.down();await qa.mouse.move(handle.x-80,handle.y+100,{steps:20});await qa.mouse.up();
 await qa.waitForFunction(h=>JSON.parse(localStorage.getItem('neo-pro-research-workspace-v1')).layout[0].h!==h,old);checks.push('resize persists geometry');
 await qa.getByRole('button',{name:'新增研究面板',exact:true}).click();await qa.waitForFunction(()=>document.querySelectorAll('.research-panel').length===3);await panels().last().getByTitle('移除此面板').click();await qa.waitForFunction(()=>document.querySelectorAll('.research-panel').length===2);
 await qa.reload();await qa.locator('.nr-entity').first().waitFor();assert((await first().innerText()).includes('6488 · 2026-11-12'),'restore symbol/date');assert(await qa.getByLabel('截至時間',{exact:true}).inputValue()==='10:00','restore cursor');checks.push('add/remove/reload');
 await qa.getByLabel('其他代號',{exact:true}).fill('0000');await qa.getByRole('button',{name:'查詢',exact:true}).click();await first().getByText('此查詢沒有示範資料').waitFor();checks.push('missing data');
 for(const key of ['b','s','Escape','Escape'])await qa.keyboard.press(key);const calls=await qa.evaluate(()=>window.__researchCalls);assert(calls.filter(c=>c.kind!=='WebSocket'||!c.url.startsWith('ws://127.0.0.1:5174/')).length===0,'network attempts');checks.push('zero fetch/XHR/SSE/broker socket attempts');
 const blocked={};for(const route of ['/api/accounts','/api/orders','/admin','/stream','/index.html','/approval.html']){const r=await context.request.get('http://127.0.0.1:5174'+route);blocked[route]=r.status();assert(r.status()===403,'route '+route)}checks.push('forbidden routes rejected');
 await qa.evaluate(()=>{localStorage.setItem('sj-pro-workspace-v5',JSON.stringify({blocks:[{type:'ticket'}]}));localStorage.setItem('neo-pro-research-workspace-v1',JSON.stringify({version:1,panels:[{id:'research-bad',type:'ticket'},{id:'research-safe',type:'neo-research',pin:'2891'}],layout:[]}))});await qa.reload();await qa.locator('.nr-entity').first().waitFor();assert(await panels().count()===1,'restore allowlist');checks.push('legacy/trading panels discarded');
 assert(errors.length===0,errors.join(';'));return{checks,blocked,calls:calls.map(c=>({...c,url:c.url.split('?')[0]})),pageErrors:errors,requests:requests.length,viewport:{width:1440,height:1100}};
 }finally{await context.close()}
};
