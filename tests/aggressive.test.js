import { suite, test, eq, assert } from "./harness.js";
import { scanProfile, selectPatternCandidates, earlyObservation, barActivity } from "../js/core/scan-profile.js";
import { stage2Liquidity } from "../js/scanner/prefilter.js";
import { derivePatternEntryCandidate } from "../js/core/pattern-entry.js";
import { renderPatternResults } from "../js/ui/pattern-results.js";
import { state } from "../js/state.js";

const items = Array.from({length:250},(_,i) => ({symbol:`T${i}USDT`,quoteVolume:10_000_000-i*1000,count:50000+i,change24h:i/10}));
export function run() {
  suite("aggressive exploration");
  test("standard preset retains its original breadth and pivot depth", () => {
    eq(scanProfile("standard").limit,100); eq(scanProfile("standard").pivotDepth,3);
    eq(scanProfile("aggressive").limit,200); eq(scanProfile("aggressive").pivotDepth,2);
  });
  test("default selection keeps volume ordering", () => {
    const rows=selectPatternCandidates(items,{scanProfile:"standard"},100);
    eq(rows.length,100); eq(rows[99].symbol,"T99USDT");
  });
  test("aggressive selection adds movers, activity, and eligible favorites without duplicates", () => {
    const rows=selectPatternCandidates(items,{scanProfile:"aggressive",favorites:["T230USDT"],excluded:["T0USDT"]},200);
    eq(rows.length,200); eq(new Set(rows.map(row=>row.symbol)).size,200);
    assert(rows.some(row=>row.symbol==="T230USDT")); assert(rows.some(row=>row.symbol==="T249USDT"));
    assert(!rows.some(row=>row.symbol==="T0USDT"));
  });
  test("invalid liquidity numbers fail closed", () => {
    const result=stage2Liquidity([{symbol:"BADUSDT"}],[{symbol:"BADUSDT",lastPrice:"bad",quoteVolume:"bad",count:"bad",priceChangePercent:"bad"}],Date.now());
    eq(result.prefiltered.length,0);
  });
  test("explicit 200 symbol prefilter is no longer truncated to 130", () => {
    const universe=items.map(row=>({symbol:row.symbol}));
    const tickers=items.map(row=>({...row,lastPrice:1,priceChangePercent:1}));
    eq(stage2Liquidity(universe,tickers,Date.now(),{minPrice:.0001,minQuoteVolume:5_000_000,minTradeCount:50000,topByVolume:200}).prefiltered.length,200);
  });
  test("early watch can show an unconfirmed pattern without inventing a trade plan", () => {
    const patterns=[{name:"초기 플래그",timeframes:{"5m":{bias:"bullish",fitScore:50,status:"forming",completionPct:60}}}];
    const watch=earlyObservation({patterns,ema200ByTimeframe:{"4h":{position:"below"}}});
    eq(watch.direction,"long");eq(watch.stage,"조기 관찰");assert(watch.warnings.some(x=>x.includes("4h")));
    const plan=derivePatternEntryCandidate({patterns,timeframes:["5m"],price:100,atrByTimeframe:{"5m":1}});
    assert(plan.entryLow==null);
  });
  test("short watch mirrors long watch and never uses 4h-only forming evidence", () => {
    const pattern={name:"하락 플래그",timeframes:{"15m":{bias:"bearish",fitScore:60,status:"forming",completionPct:80}}};
    eq(earlyObservation({patterns:[pattern]}).direction,"short");eq(earlyObservation({patterns:[pattern]}).stage,"돌파 접근");
    eq(earlyObservation({patterns:[{...pattern,timeframes:{"4h":pattern.timeframes["15m"]}}]}),null);
  });
  test("relative volume uses previous candles and leaves doji direction unset", () => {
    const bars=Array.from({length:22},()=>({open:100,close:101,high:102,low:99,volume:100}));
    bars.at(-1).volume=300;eq(barActivity(bars).volumeRatio,3);
    bars.at(-1).close=100;eq(barActivity(bars).direction,null);
  });
  test("early tab retains activity-only observations and never creates entry levels", () => {
    const previous={settings:state.settings,rows:state.patternResults,phase:state.scan.phase,meta:state.patternScanMeta};
    const handlers=new Map();
    const el={innerHTML:"",querySelectorAll(selector){return selector==="[data-pattern-scan-side]"?["early","long","short","fractal"].map(side=>({dataset:{patternScanSide:side},addEventListener(_event,fn){handlers.set(side,fn);}})):[];}};
    try {
      state.settings={...state.settings,scanProfile:"aggressive",patternFamily:"all",showFavoritesOnly:false,excluded:[]};
      state.patternScanMeta={candidateCount:1,requestedTimeframes:["5m"],completedRequests:1,failedRequests:0,scanProfile:"aggressive"};state.scan.phase="done";
      state.patternResults=[{symbol:"TESTUSDT",scanProfile:"aggressive",price:100,quoteVolume:6_000_000,patterns:[],scannedTimeframes:["5m"],activityByTimeframe:{"5m":{volumeRatio:3,rangeRatio:1.2,direction:"long"}}}];
      renderPatternResults(el);handlers.get("early")();
      assert(el.innerHTML.includes("TESTUSDT"),"activity-only row must remain visible");
      assert(el.innerHTML.includes("거래량 3.0배"),"volume evidence must be displayed");
      assert(!el.innerHTML.includes("<small>진입 후보 구간</small>"),"watch-only row must not expose entry levels");
    } finally {
      handlers.get("long")?.();state.settings=previous.settings;state.patternResults=previous.rows;state.scan.phase=previous.phase;state.patternScanMeta=previous.meta;
    }
  });
}
