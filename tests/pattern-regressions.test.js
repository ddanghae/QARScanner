import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {detectChartPatterns,groupPatternsByTimeframe} from '../js/core/chart-patterns.js';
import {evaluatePatternOutcome,outcomeSummary,replayPatternHistory} from '../js/core/pattern-validation.js';
import {derivePatternEntryCandidate} from '../js/core/pattern-entry.js';
import * as Cup from '../js/core/cup-handle.js';
import * as Life from '../js/core/w-scan-state.js';

function series(points,leg=8,tail=[-.25,-.5,-.75,-1,-1.25]){
 const out=[],push=p=>out.push({openTime:out.length*3600000,closeTime:(out.length+1)*3600000-1,open:p,close:p,high:p+.2,low:p-.2,volume:100});
 const lead=points[1]>points[0]?1:-1;for(let j=4;j>0;j--)push(points[0]+lead*j);push(points[0]);
 for(let k=1;k<points.length;k++)for(let j=1;j<=leg;j++)push(points[k-1]+(points[k]-points[k-1])*j/leg);
 for(const d of tail)push(points.at(-1)+d);while(out.length<40)out.unshift({...out[0]});return out;
}
const detect=b=>detectChartPatterns(b,{pivotDepth:2});
const mirror=b=>b.map(x=>({...x,open:250-x.open,close:250-x.close,high:250-x.low,low:250-x.high}));
test('head must protrude beyond both shoulders in either direction',()=>{
 const wrong=series([120,106,114,107,120.5],9,[-2,-4,-6,-7,-8]);
 assert(!detect(wrong).some(p=>p.id==='head-and-shoulders'));
 assert(!detect(mirror(wrong)).some(p=>p.id==='inverse-head-and-shoulders'));
 const correct=series([120,106,126,107,120.5],9);
 assert(detect(correct).some(p=>p.id==='head-and-shoulders'));
 assert(detect(mirror(correct)).some(p=>p.id==='inverse-head-and-shoulders'));
});
test('box boundaries exclude the breakout candle on both sides',()=>{
 const b=series([110,100,110,100,110,100,110,100,110],4,[-1,-2,-3,-4,-5]);
 assert.equal(detect(b).find(p=>p.id==='rectangle').status,'forming');
 b.push({open:105,close:112,high:112.2,low:104.8,volume:200});
 const p=detect(b).find(p=>p.id==='rectangle');assert.equal(p.status,'breakout');assert.equal(p.trigger,110.2);
 assert.equal(detect(mirror(b)).find(p=>p.id==='rectangle').bias,'bearish');
});
test('a failed neckline crossing cannot remain a confirmed breakout',()=>{
 const b=series([120,108,120.5],10,[-1,-2,-14,-11,-10]);
 assert.notEqual(detect(b).find(p=>p.id==='top-double')?.status,'breakout');
 assert.notEqual(detect(mirror(b)).find(p=>p.id==='bottom-double')?.status,'breakout');
 const sustained=series([120,108,120.5],10,[-1,-2,-14,-14.5,-15]);
 assert.equal(detect(sustained).find(p=>p.id==='top-double').status,'breakout');
});
test('equal AB/CD with 61.8% retracement is recognized with reversal direction',()=>{
 const b=series([100,120,107.64,127.64],9,[-.3,-.6,-.9,-1.2,-1.5]);
 const p=detect(b).find(p=>p.id==='harmonic-abcd-bear');assert(p);assert.equal(p.bias,'bearish');assert(p.projection<p.trigger);
 assert(detect(mirror(b)).some(p=>p.id==='harmonic-abcd-bull'));
});
test('unfilled structures never count as stopped trades; same-bar fills are conservative',()=>{
 const p={status:'forming',bias:'bullish',trigger:100,invalidation:95,projection:110};
 assert.equal(evaluatePatternOutcome(p,[{open:94,high:94.5,low:93,close:94}]).status,'untriggered');
 assert.equal(evaluatePatternOutcome(p,[{high:99,low:96,close:98}]).status,'untriggered');
 assert.equal(evaluatePatternOutcome(p,[{high:112,low:94,close:110}]).status,'loss');
 assert.equal(evaluatePatternOutcome(p,[{open:111,high:112,low:99,close:101}]).status,'open','target may have occurred before retest fill');
 assert.equal(evaluatePatternOutcome({...p,projection:null},[{high:112,low:99}]).status,'insufficient');
 const summary=outcomeSummary([{status:'win',r:2},{status:'open',r:20},{status:'untriggered',r:0}]);
 assert.equal(summary.avgR,2);assert.equal(summary.totalR,2);assert.equal(summary.unrealizedR,20);assert.equal(summary.untriggered,1);
});
test('provisional structures remain identifiable but cannot expose entry levels',()=>{
 const patterns=groupPatternsByTimeframe({'5m':[{id:'test',name:'test',family:'continuation',bias:'bullish',status:'breakout',fitScore:90,trigger:100,invalidation:95,projection:120,provisional:true}]});
 const result=derivePatternEntryCandidate({patterns,timeframes:['5m'],atrByTimeframe:{'5m':2},price:101});assert.equal(result.entryLow,undefined);
});
function fixture(){const levels=[...Array.from({length:24},(_,i)=>100+i*.45),108,105,102,100,98.5,98,98.2,98.5,99,100,102,105,108,110,109,108.5,109,112];let prev=levels[0];return levels.map((c,i)=>{const o=prev;prev=c;return {t:i*900000,end:(i+1)*900000-1,o,h:Math.max(o,c)+.2,l:Math.min(o,c)-.2,c,v:i===levels.length-1?2500:1000};});}
const append=(c,o,h,l,close,v=1000)=>{const i=c.length;c.push({t:i*900000,end:(i+1)*900000-1,o,h,l,c:close,v});};
const original=r=>[...r.candidates,...r.history].find(p=>p.leftIndex===23&&p.rightIndex===37);
test('cup entry event and stop survive normal subsequent candles without moving',()=>{
 const c=fixture(),p=original(Cup.detect(c));assert.equal(p.stage,'ENTRY');
 append(c,112,112.3,111.5,112.1);const later=original(Cup.detect(c));
 assert.equal(later.stage,'ENTRY');assert.equal(later.entryTime,p.entryTime);assert.deepEqual(later.levels,p.levels);
 for(let n=40;n<=c.length;n++)assert.deepEqual(original(Cup.detect(c.slice(0,n))).events,later.events.filter(e=>e.time<=c[n-1].end));
});
test('cup stop breach invalidates before any new entry and preserves original plan',()=>{
 const c=fixture(),p=original(Cup.detect(c));append(c,108,113.2,107,113,3000);
 const later=original(Cup.detect(c));assert.equal(later.stage,'INVALID');assert.equal(later.levels.stop,p.levels.stop);assert.equal(later.entryTime,p.entryTime);
 assert.equal(later.events.filter(e=>e.type==='ENTRY').length,1);
});
test('young handle is invalidated by a broken cup floor',()=>{
 const c=fixture().slice(0,40);c.at(-1).l=90;c.at(-1).c=100;
 assert.equal(original(Cup.detect(c)).stage,'FILTERED');
});
test('a new low on the breakout candle is not a confirmed handle',()=>{
 const c=fixture();c.at(-1).l=107.9;
 assert.notEqual(original(Cup.detect(c)).stage,'ENTRY');
});
test('cup neckline failure and bounded signal age retire frozen entries',()=>{
 const c=fixture();append(c,112,112.2,108.5,109);assert.equal(original(Cup.detect(c)).stage,'INVALID');
 const d=fixture();for(let i=0;i<13;i++)append(d,112,112.3,111.5,112);
 assert.equal(original(Cup.detect(d)).stage,'EXPIRED');
});

function cupUI(){
 const els=new Map(),el=s=>{if(!els.has(s))els.set(s,{value:s==='#scope'?'1':s==='#tf'?'ALL':'',checked:false,style:{},classList:{toggle(){}},textContent:'',innerHTML:''});return els.get(s);};
 let symbol='BBBUSDT',failure=false;const requests=[],timers=[];const now=Date.now(),window={addEventListener(){}};window.parent=window;
 const context=vm.createContext({E:Cup,...Life,console,Date,Map,Set,AbortController,location:{origin:'http://test'},window,document:{querySelector:el,querySelectorAll:()=>[],hidden:false},setTimeout:()=>0,clearTimeout(){},setInterval:fn=>timers.push(fn),fetch:async url=>{
  requests.push(url);if(failure)throw Error('offline');const path=new URL(url).pathname;
  const data=path.endsWith('/exchangeInfo')?{symbols:['AAAUSDT','BBBUSDT'].map(symbol=>({symbol,status:'TRADING',contractType:'PERPETUAL',quoteAsset:'USDT'}))}:path.endsWith('/ticker/24hr')?[{symbol,quoteVolume:'100'}]:path.endsWith('/time')?{serverTime:now}:[];
  return{ok:true,status:200,json:async()=>data};
 }});
 const source=fs.readFileSync(new URL('../js/ui/cup-radar.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace('const wait=ms=>new Promise(r=>setTimeout(r,ms))','const wait=async()=>{}');
 vm.runInContext(source+'\nglobalThis.review={state,scan,render};',context);
 return{...context.review,el,requests,timers,setFailure:value=>failure=value};
}
test('cup UI tracks ranked-out candidates, excludes failed counts and refreshes clock labels',async()=>{
 const ui=cupUI(),c=fixture();ui.state.mode='live';ui.state.records.set('AAAUSDT:15m',{sym:'AAAUSDT',tf:'15m',key:'AAAUSDT:15m',c,candidates:[original(Cup.detect(c))],error:null});
 await ui.scan();assert(ui.requests.some(u=>u.includes('symbol=AAAUSDT')));assert.equal(ui.el('#countENTRY').textContent,0);
 ui.state.records.get('AAAUSDT:15m').error=null;ui.el('#results').innerHTML='unchanged';ui.timers[0]();
 assert.notEqual(ui.el('#results').innerHTML,'unchanged');assert.match(ui.el('#results').innerHTML,/갱신 필요/);
 ui.setFailure(true);await ui.scan();assert.equal(ui.state.records.get('AAAUSDT:15m').error,'offline');
});
test('replay has real samples, nonoverlapping outcomes and a purged time split',()=>{
 const bars=[],push=p=>bars.push({open:p,close:p,high:p+.2,low:p-.2,volume:100});
 for(let repeat=0;repeat<6;repeat++){
  const points=[100,120,107.64,127.64,125,100];
  for(let k=0;k<points.length-1;k++)for(let j=1;j<=9;j++)push(points[k]+(points[k+1]-points[k])*j/9);
 }
 const options={warmup:40,step:1,horizonBars:8,maxSamples:30},result=replayPatternHistory(bars,options),boundary=Math.floor(bars.length*.7);
 assert(result.train.n>0&&result.validation.n>0);
 assert(result.samples.every(s=>s.cutoff>=boundary||s.cutoff+8<=boundary));
 for(let i=1;i<result.samples.length;i++)assert(result.samples[i].cutoff>=result.samples[i-1].cutoff+8);
 const changed=bars.map((b,i)=>i>=boundary?{...b,open:200,high:201,low:199,close:200}:b),other=replayPatternHistory(changed,options);
 assert.deepEqual(other.samples.filter(s=>s.cutoff+8<=boundary),result.samples.filter(s=>s.cutoff+8<=boundary));
});

test('all patterns tab exposes neutral structures independently of entry direction',async()=>{
 const {state}=await import('../js/state.js'),{renderPatternResults}=await import('../js/ui/pattern-results.js');
 const old={results:state.patternResults,phase:state.scan.phase,settings:state.settings};
 try{
  state.settings={...state.settings,scanProfile:'standard',patternFamily:'all',favorites:[],excluded:[],showFavoritesOnly:false,excludeNewListing:false};state.scan.phase='done';
  state.patternResults=[{symbol:'NEUTRALUSDT',price:100,quoteVolume:1e8,scannedTimeframes:['5m'],ema200ByTimeframe:{},patterns:groupPatternsByTimeframe({'5m':[{id:'rectangle',name:'중립 박스 회귀검사',family:'continuation',bias:'neutral',status:'forming',fitScore:80,trigger:110,invalidation:90}]})}];
  let select;const el={innerHTML:'',querySelectorAll:selector=>selector==='[data-pattern-scan-side]'?[{dataset:{patternScanSide:'all'},addEventListener:(_name,fn)=>select=fn}]:[]};
  renderPatternResults(el);assert.match(el.innerHTML,/전체 패턴/);assert(!el.innerHTML.includes('중립 박스 회귀검사'));
  select();assert.match(el.innerHTML,/중립 박스 회귀검사/);
 }finally{state.patternResults=old.results;state.scan.phase=old.phase;state.settings=old.settings;}
});
