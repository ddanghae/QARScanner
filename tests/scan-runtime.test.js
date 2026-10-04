import test from "node:test";
import assert from "node:assert/strict";

const storage = new Map(), messages = [];
let failStorage = false;
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem(key,value) { if (failStorage) throw new Error("QuotaExceededError"); storage.set(key,value); },
};
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...args) => { const id=realTimeout(...args); id.unref?.(); return id; };
globalThis.requestAnimationFrame = callback => callback();
const paperEl = { innerHTML: "", addEventListener() {} };
globalThis.document = {
  getElementById: id => id === "paper" ? paperEl : id === "toast-container" ? {appendChild: el=>messages.push({text:el.textContent,type:el.className})} : null,
  createElement: () => ({classList:{add(){},remove(){}},addEventListener(){},remove(){}}),
};
const { state } = await import("../js/state.js");
const { CONFIG } = await import("../js/config.js");
const api = await import("../js/api/binance.js");
const scanner = await import("../js/scanner/scan-controller.js");
const paper = await import("../js/ui/paper.js");
const { resetSettings } = await import("../js/state.js");
const response = data => ({ok:true,status:200,headers:{get:()=>null},json:async()=>data});
const candidate = {symbol:"BTCUSDT",patterns:[],entryCandidate:{direction:"long",entryLow:100,entryHigh:101,stop:95,tp1:110,tp2:115,tp3:120,fitScore:72,timeframe:"5m",patternName:"flag"}};

test("paper save failure reports failure and never claims success", () => {
  storage.clear();messages.length=0;failStorage=true;
  try { paper.recordPatternTrade(candidate); }
  finally { failStorage=false; }
  assert.equal(storage.has("qar-paper"),false);
  assert.equal(messages.some(message=>message.type.includes("success")),false);
  assert.ok(messages.some(message=>message.type.includes("error")));
});

test("paper outcome persists and allows a new record after target completion", async () => {
  const now=Date.now();
  storage.set("qar-paper",JSON.stringify([{symbol:"BTCUSDT",entry:101,stop:95,tp3:120,at:now-2*86400000,id:"old",direction:"long",seed:1000,leverage:1,score:72}]));
  globalThis.fetch=async()=>response([[now-86400000,"101","121","100","120","100",now-1,"10000","100","60","6000","0"]]);
  api.clearCache();paper.initPaper();await paper.render();
  assert.equal(JSON.parse(storage.get("qar-paper"))[0].status,"closed");
  paper.recordPatternTrade(candidate);
  assert.equal(JSON.parse(storage.get("qar-paper")).length,2);
});

test("damaged paper storage is not overwritten by another record", () => {
  storage.set("qar-paper","{broken");paper.recordPatternTrade(candidate);
  assert.equal(storage.get("qar-paper"),"{broken");
});

test("aborting a scan cancels the real fetch and does not retry", async () => {
  api.clearCache();let requests=0,signal;
  globalThis.fetch=(_url,options)=>new Promise((_resolve,reject)=>{
    requests++;signal=options.signal;signal.addEventListener("abort",()=>reject(new DOMException("cancelled","AbortError")),{once:true});
  });
  const task=scanner.runScan();
  while(!signal)await new Promise(resolve=>setImmediate(resolve));
  scanner.abortScan();await task;
  assert.equal(signal.aborted,true);assert.equal(requests,1);assert.equal(state.scan.running,false);
});

test("cancelled queued requests never consume a network slot", async () => {
  api.clearCache();const previous=CONFIG.api.maxConcurrent;CONFIG.api.maxConcurrent=1;
  let resolveFirst,requests=0;
  globalThis.fetch=()=>{requests++;return new Promise(resolve=>{resolveFirst=resolve;});};
  try {
    const first=api.getExchangeInfo();
    while(!resolveFirst)await new Promise(resolve=>setImmediate(resolve));
    const controller=new AbortController();const queued=api.getTicker24h({signal:controller.signal});controller.abort();
    await assert.rejects(queued,{name:"AbortError"});resolveFirst(response({symbols:[]}));await first;
    assert.equal(requests,1);
  } finally {CONFIG.api.maxConcurrent=previous;}
});

test("full aggressive scan uses closed bars and focused refresh preserves other candidates", async () => {
  api.clearCache();resetSettings();
  state.settings={...state.settings,scanProfile:"aggressive",patternScanLimit:50,minQuoteVolume:5_000_000,includeRealtimeCandle:true};
  const now=Date.now(), span={"5m":300000,"15m":900000,"1h":3600000,"4h":14400000};
  const symbols=Array.from({length:60},(_,i)=>({symbol:`TEST${i}USDT`,baseAsset:`TEST${i}`,status:"TRADING",contractType:"PERPETUAL",quoteAsset:"USDT",onboardDate:1}));
  const tickers=symbols.map((row,i)=>({symbol:row.symbol,lastPrice:"100.5",quoteVolume:String(6_000_000+i*10000),count:"100000",priceChangePercent:String(i/10),highPrice:"101",lowPrice:"99",weightedAvgPrice:"100"}));
  let klineCalls=0;
  globalThis.fetch=async input=>{
    const url=new URL(input);
    if(url.pathname.endsWith("exchangeInfo"))return response({symbols});
    if(url.pathname.endsWith("ticker/24hr"))return response(tickers);
    assert.ok(url.pathname.endsWith("klines"));klineCalls++;
    const tf=url.searchParams.get("interval"), interval=span[tf];
    const bars=Array.from({length:240},(_,i)=>[now-(240-i)*interval,"100","101","99",i===239?"100.5":"100",i===239?"300":"100",now-(239-i)*interval-1,"10000","100","60","6000","0"]);
    bars.push([now,"100","105","90","90","10000",now+interval-1,"10000","100","60","6000","0"]);
    return response(bars);
  };
  const rows=await scanner.runScan();assert.equal(state.patternScanMeta.candidateCount,50);assert.equal(rows.length,50);
  assert.ok(rows.every(row=>row.earlyObservation.direction==="long"));assert.ok(rows.every(row=>row.latestCandleTime<now));
  const fullAt=state.patternScanMeta.fullUpdatedAt,before=klineCalls;
  await scanner.runScan({focus:true});assert.equal(state.patternResults.length,50);
  assert.equal(state.patternScanMeta.fullUpdatedAt,fullAt);assert.ok(state.patternScanMeta.focusUpdatedAt);
  assert.equal(klineCalls-before,40,"20 symbols times 2 short timeframes; upper timeframes use their caches");
});

test("failed focused requests preserve previous candidates and expose failure counts", async () => {
  const previousRows=state.patternResults.slice(), previousRetries=CONFIG.api.maxRetries;
  assert.equal(previousRows.length,50);
  CONFIG.api.maxRetries=0;api.clearCache();
  const universe=state.universe.map(row=>({...row,status:"TRADING",quoteAsset:"USDT",contractType:"PERPETUAL"}));
  const tickers=state.tickers;
  globalThis.fetch=async input=>{
    const url=new URL(input);
    if(url.pathname.endsWith("exchangeInfo"))return response({symbols:universe});
    if(url.pathname.endsWith("ticker/24hr"))return response(tickers);
    return {ok:false,status:503,headers:{get:()=>null},text:async()=>"unavailable"};
  };
  try {
    await scanner.runScan({focus:true});
    assert.equal(state.patternResults.length,50);
    assert.equal(state.patternScanMeta.focusFailedRequests,80);
    assert.deepEqual(state.patternResults.map(row=>row.symbol),previousRows.map(row=>row.symbol));
  } finally {CONFIG.api.maxRetries=previousRetries;}
});

test("unknown persisted profile migrates to standard and aggressive profile survives reload", async () => {
  storage.set("qar-ict-settings",JSON.stringify({scanProfile:"obsolete"}));
  const fallback=await import("../js/state.js?profile-fallback");
  assert.equal(fallback.state.settings.scanProfile,"standard");
  storage.set("qar-ict-settings",JSON.stringify({scanProfile:"aggressive",minQuoteVolume:5_000_000,patternScanLimit:200}));
  const aggressive=await import("../js/state.js?profile-aggressive");
  assert.equal(aggressive.state.settings.scanProfile,"aggressive");
  assert.equal(aggressive.state.settings.patternScanLimit,200);
});

test("standard realtime scan labels provisional patterns and never replays unfinished candles", async () => {
  api.clearCache();resetSettings();
  state.settings={...state.settings,scanProfile:"standard",patternTimeframes:["5m"],includeRealtimeCandle:true};
  const now=Date.now(),interval=300000;
  globalThis.fetch=async input=>{
    const url=new URL(input);
    if(url.pathname.endsWith("exchangeInfo"))return response({symbols:[{symbol:"BTCUSDT",baseAsset:"BTC",status:"TRADING",contractType:"PERPETUAL",quoteAsset:"USDT",onboardDate:1}]});
    if(url.pathname.endsWith("ticker/24hr"))return response([{symbol:"BTCUSDT",lastPrice:"103",quoteVolume:"30000000",count:"100000",priceChangePercent:"3",highPrice:"104",lowPrice:"98",weightedAvgPrice:"100"}]);
    assert.ok(url.pathname.endsWith("klines"));
    const bars=Array.from({length:240},(_,i)=>[now-(240-i)*interval,i===239?"101":"100","102","99","100","100",now-(239-i)*interval-1,"10000","100","60","6000","0"]);
    bars.push([now,"99","104","98","103","300",now+interval-1,"10000","100","60","6000","0"]);
    return response(bars);
  };
  const rows=await scanner.runScan();assert.equal(rows.length,1);
  const found=rows[0].patterns.find(p=>p.id==="bullish-engulfing").timeframes["5m"];
  assert.equal(found.provisional,true);assert.equal(found.completionPct,null);
  assert.equal(rows[0].validationByTimeframe["5m"].sampleCount,0);
  const {derivePatternEntryCandidate}=await import("../js/core/pattern-entry.js");
  assert.equal(derivePatternEntryCandidate({...rows[0],timeframes:["5m"]}).entryLow,undefined);
});
