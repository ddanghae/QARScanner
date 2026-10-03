'use strict';
import * as E from '../core/w-pattern.js';
const $=s=>document.querySelector(s);
const LABEL={WATCH:'관심',TARGET:'타겟',ENTRY:'타점',INVALID:'무효',EXPIRED:'만료',FILTERED:'필터 제외',BREAKOUT:'돌파 관찰'};
const TF={'15m':900000,'1h':3600000};
const state={records:new Map(),cache:new Map(),loading:false,mode:'empty',stage:'ALL',lastAuto:0,nextAutoAt:0,cooldown:0,offset:0,scanned:false,selected:null,visible:24};
const esc=s=>String(s).replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const price=n=>Number.isFinite(n)?n.toLocaleString('en-US',{maximumSignificantDigits:7}):'—';
const time=t=>new Date(t).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const host={embedded:window.parent!==window,active:window.parent===window,mainBusy:false};
function hostBusy(busy){if(host.embedded)window.parent.postMessage({type:'qar:w-busy',busy},location.origin);}
const detectionOptions=()=>({filters:$('#quality').checked,allowContinuation:$('#continuation').checked});
function recheck(){
 $('#continuation').disabled=!$('#quality').checked;state.visible=24;
 for(const r of state.records.values())if(r.c.length)Object.assign(r,E.detect(r.c,detectionOptions()));
 if($('#detail').open)$('#detail').close();render();
}
function status(text,error=false){$('#status').textContent=text;$('#status').classList.toggle('error',error);}
function banner(text){$('#banner').textContent=text;$('#banner').classList.toggle('show',!!text);}
async function api(path){
 if(Date.now()<state.cooldown)throw Error('API 요청 제한 · 잠시 후 다시 시도하세요');
 const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),15000);
 try{const r=await fetch('https://fapi.binance.com'+path,{signal:ctrl.signal});
  if(r.status===429||r.status===418){const seconds=Number(r.headers.get('Retry-After'));state.cooldown=Date.now()+Math.max(60,Number.isFinite(seconds)?seconds:60)*1000;throw Error('API 요청 제한 · 자동 확인 일시 대기');}
  if(!r.ok)throw Error('시세 연결 실패 (HTTP '+r.status+')');return await r.json();
 }finally{clearTimeout(timer);}
}
async function loadCandles(sym,tf,now){
 const key=sym+':'+tf,old=state.cache.get(key)||[],interval=TF[tf];
 const expected=Math.floor(now/interval)*interval-interval;
 if(old.length&&old.at(-1).t===expected)return old;
 const gap=old.length?(expected-old.at(-1).t)/interval:Infinity;
 const suffix=old.length&&gap<450?'&startTime='+(old.at(-1).t+interval):'';
 const raw=await api(`/fapi/v1/klines?symbol=${encodeURIComponent(sym)}&interval=${tf}&limit=499${suffix}`);
 if(!Array.isArray(raw))throw Error('잘못된 캔들 응답');
 const fresh=E.fromRaw(raw,now);const c=E.validate(suffix?[...old,...fresh]:fresh,interval);
 if(c.at(-1).t!==expected)throw Error('최신 완성 봉 미수신');
 // Keep this page session's causal history instead of shifting the first-V baseline.
 state.cache.set(key,c);return c;
}
async function scan(){
 if(!host.active||host.mainBusy){status('대시보드 스캔 완료 후 W 패턴 탭에서 시작하세요.');return;}
 if(state.loading)return;if(Date.now()<state.cooldown){status('요청 제한 대기 중 · 잠시 후 재시도',true);return;}
 state.loading=true;$('#scan').disabled=true;$('#demo').disabled=true;$('#scope').disabled=true;$('#progress').style.display='block';$('#progress').value=0;
 $('#quality').disabled=$('#continuation').disabled=true;const detection=detectionOptions();
 hostBusy(true);
 status('거래 가능한 USDT 무기한 선물 확인 중');
 if(state.mode==='demo'){state.records.clear();state.mode='live';render();}
 let failed=0,done=0,total=0;
 try{
  const [exchange,tickers,clock]=await Promise.all([api('/fapi/v1/exchangeInfo'),api('/fapi/v1/ticker/24hr'),api('/fapi/v1/time')]);
  const now=Number(clock.serverTime);if(!Number.isFinite(now))throw Error('서버 시간 확인 실패');state.offset=now-Date.now();
  const allowed=new Set(exchange.symbols.filter(s=>s.status==='TRADING'&&s.contractType==='PERPETUAL'&&s.quoteAsset==='USDT').map(s=>s.symbol));
  const symbols=tickers.filter(t=>allowed.has(t.symbol)&&Number(t.quoteVolume)>0).sort((a,b)=>Number(b.quoteVolume)-Number(a.quoteVolume)).slice(0,Number($('#scope').value)).map(t=>t.symbol);
  if(!symbols.length)throw Error('스캔할 종목 없음');
  const jobs=symbols.flatMap(sym=>Object.keys(TF).map(tf=>({sym,tf,key:sym+':'+tf})));total=jobs.length;
  const keys=new Set(jobs.map(j=>j.key));for(const key of state.records.keys())if(!keys.has(key))state.records.delete(key);
  state.mode='live';banner('');let index=0;
  async function worker(){while(index<jobs.length){const job=jobs[index++];
   try{const c=await loadCandles(job.sym,job.tf,now);const found=E.detect(c,detection);state.records.set(job.key,{...job,c,...found,checked:now,error:null});}
   catch(e){failed++;const old=state.records.get(job.key);if(old)state.records.set(job.key,{...old,error:e.message});else state.records.set(job.key,{...job,c:[],active:null,history:[],error:e.message});}
   done++;$('#progress').value=done/total*100;status(`스캔 ${done}/${total} · ${symbols.length}종목 × 2개 시간봉`);await wait(150);
  }}
  await Promise.all(Array.from({length:4},worker));state.scanned=true;
  state.lastAuto=Math.floor(now/TF['15m']);
  $('#updated').textContent='마지막 확인 '+time(now);
  status(`완료 · ${symbols.length}종목 / ${total-failed}개 시간봉 확인${failed?' / '+failed+'개 실패':''}`,failed>0);
  if(failed)banner(`시세 수신 실패 ${failed}개. 이전 결과는 ‘갱신 실패’로 표시되며, 새 타점으로 취급하지 않습니다.${state.cooldown>Date.now()?' 요청 제한이 풀린 뒤 다시 확인합니다.':''}`);
 }catch(e){for(const r of state.records.values())r.error=e.message;status(e.name==='AbortError'?'시세 서버 응답 시간 초과':e.message,true);banner('실시간 데이터를 확인하지 못했습니다. 네트워크 또는 거래소 접근 상태를 확인하고 다시 스캔하세요. 예시 데이터로 자동 전환하지 않습니다.');}
 finally{state.nextAutoAt=Date.now()+60000;state.loading=false;$('#scan').disabled=!host.active||host.mainBusy;$('#demo').disabled=false;$('#scope').disabled=false;$('#quality').disabled=false;$('#continuation').disabled=!$('#quality').checked;$('#progress').style.display='none';render();hostBusy(false);}
}
function chart(r,p,large=false){
 const ended=['INVALID','EXPIRED','FILTERED'].includes(p.stage),lastEventIndex=ended?r.c.findIndex(b=>b.end===p.events.at(-1).time):r.c.length-1;
 const start=Math.max(0,p.peakIndex-5),end=ended?Math.min(r.c.length,lastEventIndex+4):r.c.length,c=r.c.slice(start,end);
 const W=620,H=large?275:205,left=14,right=74,top=24,bottom=25;
 const lo=Math.min(...c.map(x=>x.l)),hi=Math.max(...c.map(x=>x.h)),pad=(hi-lo)*.12||1,min=lo-pad,max=hi+pad;
 const x=i=>left+(i-start+.5)*(W-left-right)/c.length,y=v=>top+(max-v)/(max-min)*(H-top-bottom),bw=Math.max(1,Math.min(7,(W-left-right)/c.length*.56));
 let s=`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(r.sym)} ${esc(r.tf)} 캔들 차트와 W 패턴">`;
 for(let j=0;j<3;j++){const yy=top+j*(H-top-bottom)/2;s+=`<line x1="${left}" x2="${W-right}" y1="${yy}" y2="${yy}" stroke="#243138" stroke-width=".7"/>`;}
 c.forEach((b,k)=>{const xx=x(k+start),color=b.c>=b.o?'#609e8d':'#9a6973';s+=`<line x1="${xx}" x2="${xx}" y1="${y(b.h)}" y2="${y(b.l)}" stroke="${color}"/><rect x="${xx-bw/2}" y="${Math.min(y(b.o),y(b.c))}" width="${bw}" height="${Math.max(1,Math.abs(y(b.o)-y(b.c)))}" fill="${color}"/>`;});
 const neckY=y(p.neck);s+=`<line x1="${left}" x2="${W-right+3}" y1="${neckY}" y2="${neckY}" stroke="#718898" stroke-dasharray="5 5"/><text x="${W-right+7}" y="${neckY+3}" fill="#9aafb9" font-size="10">넥라인</text>`;
 const points=[[p.peakIndex,r.c[p.peakIndex].h],[p.l1Index,p.l1],[p.neckIndex,p.neck]];
 if(p.l2Index!==undefined)points.push([p.l2Index,p.l2]);if(p.entryIndex!==undefined)points.push([p.entryIndex,p.entry]);
 s+=`<polyline points="${points.map(([i,v])=>x(i)+','+y(v)).join(' ')}" fill="none" stroke="${p.stage==='ENTRY'?'#6ee7b7':'#a7c6d6'}" stroke-width="2.3" stroke-linejoin="round" opacity=".85"/>`;
 [[p.l1Index,p.l1,'L1'],[p.l2Index,p.l2,'L2']].filter(v=>v[0]!==undefined).forEach(([i,v,label])=>{s+=`<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="#d4e6e7"/><text x="${x(i)}" y="${y(v)+16}" fill="#b7ced5" text-anchor="middle" font-size="10">${label}</text>`;});
 if(p.entryIndex!==undefined)s+=`<circle cx="${x(p.entryIndex)}" cy="${y(p.entry)}" r="4" fill="#6ee7b7"/><text x="${x(p.entryIndex)}" y="${y(p.entry)-10}" fill="#6ee7b7" text-anchor="middle" font-size="11">타점</text>`;
 s+=`<text x="${left}" y="${H-4}" fill="#708891" font-size="9">${time(c[0].t)}</text><text x="${W-right}" y="${H-4}" text-anchor="end" fill="#708891" font-size="9">${time(c.at(-1).t)}</text></svg>`;return s;
}
function rows(){return [...state.records.values()].flatMap(r=>state.stage==='HISTORY'?r.history.slice(-12).map(p=>({r,p})):state.stage==='FILTERED'?r.history.filter(p=>p.stage==='FILTERED').map(p=>({r,p})):r.active?[{r,p:r.active}]:[]);}
function checkSummary(p){
 if(!p.filtered)return '검증 필터 꺼짐 · 기본 탐지만 적용';
 if(p.stage==='WATCH')return '첫 V 관심 후보 · 두 번째 지지부터 구조 검증';
 if(p.stage==='FILTERED')return '제외 사유 · '+p.reason;
 if(p.stage==='INVALID'||p.stage==='EXPIRED')return p.reason;
 return p.stage==='ENTRY'?'구조·거래량·돌파 봉·다음 봉 지지 통과':p.pending?'돌파 검증 통과 · 다음 완성 봉의 지지 대기':'구조 검증 통과 · 거래량을 동반한 돌파 대기';
}
function checkDetails(p){
 if(!p.filtered)return '<p class="filter-note">검증 필터를 끈 결과입니다. 거래량과 돌파 유지 조건은 적용하지 않았습니다.</p>';
 if(!p.checks?.length)return '<p class="filter-note">아직 첫 V 관심 단계입니다. 두 번째 저점이 확인되면 구조 검증을 시작합니다.</p>';
 return `<h3 style="font-size:14px;margin-top:20px">필터 검사 내역</h3><ul class="checks">${p.checks.map(x=>`<li><b class="${x.pass?'checkpass':x.required?'checkfail':'checkinfo'}">${x.pass?'✓':x.required?'✕':'△'} ${esc(x.label)}${x.required?'':' · 참고'}</b><small>${esc(x.value)}</small></li>`).join('')}</ul>${p.stage==='TARGET'&&p.pending?'<p class="amber">다음 봉 지지를 기다리고 있습니다. 아직 타점이 아닙니다.</p>':''}<p class="filter-note">통과는 현재 규칙을 만족한다는 뜻이며, 성공 확률이나 수익률을 뜻하지 않습니다.</p>`;
}
function card(r,p,dual){
 const ended=['INVALID','EXPIRED','FILTERED'].includes(p.stage),fresh=!r.error&&p.stage==='ENTRY',last=r.c.at(-1),chase=p.entry&&last.c>p.neck+2*p.atr;
 const cls=p.stage.toLowerCase();const key=r.key+'|'+p.id;
 return `<article class="card ${cls}"><div class="cardhead"><div class="symbol">${esc(r.sym.replace('USDT',''))}<small>${r.tf==='15m'?'15분':'1시간'}</small></div><span class="badge ${cls}">${LABEL[p.stage]}</span></div>
 <div class="cardmeta"><span class="${r.error?'stale':dual?'dual':''}">${r.error?'갱신 실패 · 이전 결과':state.mode==='demo'?'구조 설명용 가상 데이터':dual?'두 시간봉에서 패턴 추적 중':'완성 봉 기준'}</span><span>${esc(p.kind||'두 번째 눌림 대기')}</span></div>${chart(r,p)}
 <div class="values"><div><span>첫 저점 L1</span><b>${price(p.l1)}</b></div><div><span>두 번째 저점 L2</span><b>${price(p.l2)}</b></div><div><span>넥라인</span><b>${price(p.neck)}</b></div></div>
 <div class="checkline ${p.stage==='FILTERED'?'stale':''}">${esc(checkSummary(p))}</div>
 <div class="entrybox ${fresh?'':'waiting'}"><div><div class="label">${p.entry?(p.filtered?'검증 완료 봉 종가':'W 완성 봉 종가'):'타점 표시'}</div><strong>${p.entry?price(p.entry):p.stage==='WATCH'?'두 번째 지지 확인 후 대기':ended?'표시하지 않음':p.pending?'다음 봉 지지 확인 대기':'넥라인 종가 돌파 대기'}</strong></div><div class="time">${p.entry?time(p.entryTime)+'<br>': ''}${r.error?'재확인 필요':ended?LABEL[p.stage]:chase?'넥라인에서 2 ATR 이상 상승':p.entry?'돌파 거래량 '+p.volumeRatio.toFixed(2)+'배':p.l2?'두 번째 저점 이탈 시 취소':'첫 저점 이탈 시 취소'}</div></div>
 <div class="foot"><span>마지막 봉 ${time(last.end)}${state.mode==='demo'?' · 예시':''}</span><button data-detail="${esc(key)}">상세 보기 ↗</button></div></article>`;
}
function render(){
 const excluded=[...state.records.values()].filter(r=>!r.error).reduce((n,r)=>n+r.history.filter(p=>p.stage==='FILTERED').length,0);
 $('#filterSummary').textContent=$('#quality').checked?`검증 필터 켜짐 · 조회 데이터 내 제외 ${excluded}건`:'검증 필터 꺼짐 · 기존 단일 돌파 방식';
 for(const stage of ['WATCH','TARGET','ENTRY'])$('#count'+stage).textContent=[...state.records.values()].filter(r=>!r.error&&r.active?.stage===stage).length;
 const query=$('#query').value.trim().toUpperCase(),tf=$('#tf').value;
 const all=rows().filter(({r,p})=>(tf==='ALL'||r.tf===tf)&&r.sym.includes(query)&&(state.stage==='ALL'||state.stage==='HISTORY'||p.stage===state.stage));
 const order={ENTRY:0,TARGET:1,WATCH:2,INVALID:3,EXPIRED:4,FILTERED:5};all.sort((a,b)=>(!!a.r.error-!!b.r.error)||(['HISTORY','FILTERED'].includes(state.stage)?0:order[a.p.stage]-order[b.p.stage])||b.p.events.at(-1).time-a.p.events.at(-1).time);
 const counts=new Map();for(const r of state.records.values())if(r.active&&!r.error)counts.set(r.sym,(counts.get(r.sym)||0)+1);
 $('#results').innerHTML=all.length?all.slice(0,state.visible).map(({r,p})=>card(r,p,counts.get(r.sym)>1)).join('')+(all.length>state.visible?`<button data-more style="grid-column:1/-1">더 보기 · ${state.visible} / ${all.length}개 표시</button>`:''):`<div class="empty"><svg viewBox="0 0 120 60" aria-hidden="true"><path d="M5 8L30 47L57 15L83 39L114 4" fill="none" stroke="#486f66" stroke-width="2"/><circle cx="83" cy="39" r="4" fill="#6ee7b7"/></svg><strong>${state.mode==='empty'?'W가 만들어지는 순서대로 추적합니다.':state.stage==='HISTORY'?'종료된 패턴이 없습니다.':'조건에 맞는 패턴이 없습니다.'}</strong>${state.mode==='empty'?'시장 스캔으로 현재 후보를 찾거나, 예시에서 관심 → 타겟 → 타점을 확인하세요.':'검색어와 필터를 확인하거나 다음 완성 봉을 기다려 주세요.'}</div>`;
 if($('#detail').open&&state.selected)showDetail(state.selected,false);
}
function showDetail(key,open=true){const at=key.indexOf('|'),r=state.records.get(key.slice(0,at)),id=key.slice(at+1);if(!r)return;const p=[r.active,...r.history].find(p=>p?.id===id);if(!p)return;state.selected=key;
 $('#detailContent').innerHTML=`<div class="dialoghead"><h2>${esc(r.sym)} · ${r.tf==='15m'?'15분봉':'1시간봉'} <span class="badge ${p.stage.toLowerCase()}">${LABEL[p.stage]}</span></h2><button id="closeDetail" aria-label="상세 닫기">✕</button></div>${r.error?'<p class="stale">갱신 실패 · 이전 데이터입니다.</p>':''}${state.mode==='demo'?'<p class="amber">구조를 설명하기 위한 가상 데이터입니다.</p>':''}${chart(r,p,true)}
 <p class="filter-note">${esc(checkSummary(p))}</p><div class="detailrow"><span>패턴 분류</span><b>${esc(p.kind||'두 번째 저점 대기')}</b></div>
 <div class="detailrow"><span>돌파 확인 기준</span><b>종가 &gt; ${price(p.neck+E.defaults.breakoutATR*p.atr)}</b></div><div class="detailrow"><span>${p.stage==='WATCH'?'패턴 무효 기준':'지지 무효 기준'}</span><b>저가 &lt; ${price(p.l2??p.l1)}</b></div>
 ${p.filtered?`<div class="detailrow"><span>타점 이후 돌파 실패 기준</span><b>종가 &lt; ${price(p.neck-E.defaults.failureATR*p.atr)}</b></div><div class="detailrow"><span>최초 돌파 시각 / 종가</span><b>${p.breakoutTime?time(p.breakoutTime)+' / '+price(p.breakoutPrice):'검증된 돌파 없음'}</b></div>`:''}
 <div class="detailrow"><span>${p.filtered?'검증 타점 시각 / 종가':'W 완성 시각 / 종가'}</span><b>${p.entry?time(p.entryTime)+' / '+price(p.entry):'미확정'}</b></div><div class="detailrow"><span>최신 완성 봉 종가</span><b>${price(r.c.at(-1).c)}</b></div>${checkDetails(p)}
 <ol class="timeline">${p.events.map(e=>`<li><b>${LABEL[e.type]}</b> · ${time(e.time)}<br>${esc(e.reason)}</li>`).join('')}</ol><p style="color:var(--muted);font-size:11px">저점은 이후 2개 봉으로 확인합니다. 검증 필터 적용 시 타점은 돌파 다음 봉의 종가입니다. 실제 주문 체결가를 뜻하지 않습니다.</p><a href="https://www.tradingview.com/chart/?symbol=BINANCE%3A${encodeURIComponent(r.sym)}.P&interval=${r.tf==='15m'?'15':'60'}" target="_blank" rel="noopener noreferrer">TradingView에서 종목 보기 ↗</a>`;
 $('#closeDetail').onclick=()=>$('#detail').close();if(open&&!$('#detail').open)$('#detail').showModal();
}
function demoCandles(tf,length,scale=1){const interval=TF[tf],anchor=Math.floor((Date.now()-TF['1h']*50)/TF['1h'])*TF['1h'];const levels=Array.from({length:20},(_,i)=>110+Math.sin(i)*.12).concat([107,103,100,102,104,107,110,108,105,103,102,104,106,111,112]);let previous=levels[0];return levels.slice(0,length).map((v,i)=>{const o=previous;previous=v;return{t:anchor+i*interval,end:anchor+(i+1)*interval-1,o:o*scale,h:(Math.max(o,v)+.35)*scale,l:(Math.min(o,v)-.35)*scale,c:v*scale,v:i===33?2100:1000};});}
function demo(){if(state.loading)return;$('#auto').checked=false;state.records.clear();state.mode='demo';state.scanned=false;state.stage='ALL';document.querySelectorAll('[data-stage]').forEach(b=>{b.classList.toggle('active',b.dataset.stage==='ALL');b.setAttribute('aria-pressed',String(b.dataset.stage==='ALL'));});$('#tf').value='ALL';$('#query').value='';
 const definitions=[['DEMO-AUSDT','15m',27,1],['DEMO-BUSDT','15m',33,.1],['DEMO-CUSDT','1h',35,.01],['DEMO-DUSDT','15m',35,.01]];
 for(const [sym,tf,n,m]of definitions){const c=demoCandles(tf,n,m),key=sym+':'+tf;if(sym==='DEMO-DUSDT')c[33].v=700;state.records.set(key,{sym,tf,key,c,...E.detect(c,detectionOptions()),checked:Date.now(),error:null});}
 banner('예시 모드 · 세 단계의 구조를 보여 주는 가상 종목입니다. 실시간 결과는 시장 스캔을 눌러 확인하세요.');status('예시 · 관심 / 타겟 / 타점');$('#updated').textContent='가상 데이터';render();
}
$('#scan').onclick=scan;$('#demo').onclick=demo;
$('#quality').onchange=$('#continuation').onchange=recheck;
document.querySelectorAll('[data-stage]').forEach(b=>b.onclick=()=>{state.visible=24;state.stage=b.dataset.stage;document.querySelectorAll('[data-stage]').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',String(x===b));});render();});
$('#tf').onchange=$('#query').oninput=()=>{state.visible=24;render();};
$('#results').onclick=e=>{if(e.target.closest('[data-more]')){state.visible+=24;render();return;}const b=e.target.closest('[data-detail]');if(b)showDetail(b.dataset.detail);};
$('#auto').onchange=()=>{if($('#auto').checked&&!state.loading)scan();};
$('#detail').addEventListener('click',e=>{if(e.target===$('#detail')){const r=$('#detail').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('#detail').close();}});
setInterval(()=>{const now=Date.now()+state.offset,bucket=Math.floor(now/TF['15m']);if(host.active&&!host.mainBusy&&!document.hidden&&$('#auto').checked&&!state.loading&&state.mode!=='demo'&&bucket>state.lastAuto&&now%TF['15m']>7000&&Date.now()>=Math.max(state.cooldown,state.nextAutoAt))scan();},15000);
window.addEventListener('message',event=>{
 if(!host.embedded||event.source!==window.parent||event.origin!==location.origin||event.data?.type!=='qar:w-context')return;
 const wasBusy=host.mainBusy;host.active=event.data.active===true;host.mainBusy=event.data.mainBusy===true;
 if(!state.loading){$('#scan').disabled=!host.active||host.mainBusy;if(host.mainBusy)status('대시보드 스캔 중 · 완료 후 W 스캔 가능');else if(wasBusy)status('대시보드 스캔 완료 · W 스캔을 시작할 수 있습니다.');}
});
if(host.embedded){$('#scan').disabled=true;window.parent.postMessage({type:'qar:w-ready'},location.origin);}
render();
