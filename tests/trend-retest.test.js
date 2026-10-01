import { suite, test, assert, eq, approx } from "./harness.js";
import { assessTrendRetest, observeSupply, currentRetestSignal } from "../js/core/trend-retest.js";
import { retestCardHtml, retestTabHtml, bindRetestControls } from "../js/ui/trend-retest.js";
import { CONFIG } from "../js/config.js";

const t = Date.UTC(2026, 8, 30, 12), M = 300000;
function bar(time, close, interval = M) {
  return { openTime:time,closeTime:time+interval-1,open:close-.1,close,high:close+.3,low:close-.3,
    volume:100,takerBuyBase:60,takerSellBase:40 };
}
function fixture() {
  const five=Array.from({length:80},(_,i)=>bar(t-(80-i)*M,90+i*.12+Math.sin(i*Math.PI/6)*.7));
  const trigger=five.at(-1).close+.1;
  const pattern={id:"test-flag",name:"상승 플래그",family:"continuation",bias:"bullish",status:"forming",fitScore:75,trigger,invalidation:trigger-3,projection:trigger+5};
  five.push({...bar(t,trigger+.8),open:trigger+.6,high:trigger+1,low:trigger+.5});
  five.push({...bar(t+M,trigger+.1),open:trigger+.3,high:trigger+.5,low:trigger-.2});
  five.push({...bar(t+2*M,trigger+.9),open:trigger+.2,high:trigger+1.1,low:trigger+.1});
  const hourly=Array.from({length:240},(_,i)=>bar(t-(240-i)*3600000,80+i*.1+Math.sin(i*Math.PI/6),3600000));
  const detect=prefix=>prefix.at(-1).closeTime===t-1?[pattern]:[];
  return {frames:{"5m":five,"1h":hourly},pattern,detect,asOf:t+3*M};
}
function signal(f, extra={}) { return assessTrendRetest(f.frames,{asOf:f.asOf,detect:f.detect,...extra}); }

export function run() {
  suite("QAR trend and supply retest");
  test("a frozen breakout needs a later first retest and another closed confirmation bar",()=>{
    const f=fixture(), frames=f.frames;
    const breakout=signal({...f,frames:{...frames,"5m":frames["5m"].slice(0,-2)},asOf:t+M});
    eq(breakout.status,"breakout");eq(breakout.plan,null);
    const retest=signal({...f,frames:{...frames,"5m":frames["5m"].slice(0,-1)},asOf:t+2*M});
    eq(retest.status,"retest");eq(retest.plan,null);
    const ready=signal(f);eq(ready.status,"ready");assert(ready.plan.stop<ready.plan.entryLow);assert(ready.plan.netRR>=1.5);
    eq(ready.sourceAt,t-1);eq(ready.breakoutAt,t+M-1);eq(ready.retestAt,t+2*M-1);eq(ready.confirmedAt,t+3*M-1);
  });
  test("short side mirrors the long sequence and cost-adjusted risk",()=>{
    const f=fixture(), long=signal(f), reflect=p=>220-p;
    const mirrored=Object.fromEntries(Object.entries(f.frames).map(([tf,bars])=>[tf,bars.map(c=>({...c,open:reflect(c.open),close:reflect(c.close),high:reflect(c.low),low:reflect(c.high),takerBuyBase:c.takerSellBase,takerSellBase:c.takerBuyBase}))]));
    const p={...f.pattern,bias:"bearish",trigger:reflect(f.pattern.trigger),invalidation:reflect(f.pattern.invalidation),projection:reflect(f.pattern.projection)};
    const short=signal({...f,frames:mirrored,detect:prefix=>prefix.at(-1).closeTime===t-1?[p]:[]});
    eq(short.status,"ready");eq(short.direction,"short");assert(short.plan.stop>short.plan.entryHigh);
    approx(short.plan.stop,reflect(long.plan.stop));assert(short.plan.netRR>=1.5);
  });
  test("unfinished and future candles cannot alter the confirmed result",()=>{
    const f=fixture(), before=signal(f);
    f.frames["5m"].push({...bar(t+3*M,1),high:10000});
    f.frames["1h"].push({...bar(t,1,3600000),high:10000});
    const after=signal(f);eq(after.status,before.status);eq(JSON.stringify(after.plan),JSON.stringify(before.plan));
  });
  test("missing, duplicate, stale and malformed bars fail closed",()=>{
    for(const kind of ["gap","duplicate","stale","malformed"]){
      const f=fixture();
      if(kind==="gap")f.frames["5m"].splice(70,1);
      if(kind==="duplicate")f.frames["5m"].splice(70,0,f.frames["5m"][70]);
      if(kind==="stale")f.asOf+=2*M;
      if(kind==="malformed")f.frames["5m"][70].high=1;
      eq(signal(f).status,"unavailable",kind);
    }
  });
  test("opposite hourly context cannot confirm a long setup",()=>{
    const f=fixture();f.frames["1h"]=f.frames["1h"].map(c=>({...c,open:220-c.open,close:220-c.close,high:220-c.low,low:220-c.high}));
    eq(signal(f).plan,null);assert(signal(f).status!=="ready");
  });
  test("structure loss and already reached targets never expose a plan",()=>{
    const f=fixture();f.frames["5m"].at(-1).low=f.pattern.invalidation-.1;
    eq(signal(f).status,"invalid");eq(signal(f).plan,null);
    const g=fixture();g.frames["5m"].at(-1).high=g.pattern.projection+.1;
    eq(signal(g).status,"late");eq(signal(g).plan,null);
  });
  test("fees, excessive stops, second confirmation delays and chasing block review prices",()=>{
    const f=fixture();eq(signal(f,{config:{...CONFIG.trendRetest,minNetRR:100}}).status,"risk");
    eq(signal(f,{config:{...CONFIG.trendRetest,maxStopPct:.01}}).status,"risk");
    const g=fixture();g.frames["5m"].push(bar(t+3*M,g.pattern.trigger+2));g.asOf+=M;
    eq(signal(g).status,"late");eq(signal(g).plan,null);
    const h=fixture();h.frames["5m"]=h.frames["5m"].slice(0,-1);
    for(let i=2;i<10;i++)h.frames["5m"].push({...bar(t+i*M,h.pattern.trigger+.1),high:h.pattern.trigger+.5,low:h.pattern.trigger-.1});
    h.asOf=t+10*M;eq(signal(h).status,"expired");eq(signal(h).plan,null);
  });
  test("live expiry removes prices before any new network scan",()=>{
    const f=fixture(), ready=signal(f);
    eq(currentRetestSignal(ready,ready.expiresAt).plan,null);
    const html=retestCardHtml({symbol:"TESTUSDT",price:100,quoteVolume:5000000,trendRetest:ready},1,ready.expiresAt);
    assert(!html.includes("retest-plan"));assert(html.includes("신호 만료"));
  });
  test("volume spike alone stays neutral; absent taker data does not invent direction",()=>{
    const f=fixture();for(const c of f.frames["5m"].slice(-3)){c.volume=1000;c.takerBuyBase=500;c.takerSellBase=500;}
    const flow=observeSupply(f.frames["5m"],f.asOf);assert(flow.relVolume>=2);eq(flow.delta,0);
    assert(flow.evidence.some(x=>x.side==="neutral"));
    for(const c of f.frames["5m"])delete c.takerBuyBase;
    eq(observeSupply(f.frames["5m"],f.asOf).buyRatio,null);
  });
  test("OI context ignores future/stale observations and funding never changes entry",()=>{
    const f=fixture(), bars=f.frames["5m"];
    const flow=observeSupply(bars,f.asOf,{oi:[{time:f.asOf-900000,oi:100},{time:f.asOf,oi:110},{time:f.asOf+M,oi:1000}],funding:.001,fundingAt:f.asOf});
    approx(flow.oiChangePct,10);eq(flow.funding,.001);
    eq(observeSupply(bars,f.asOf,{oi:[{time:f.asOf-1800000,oi:100},{time:f.asOf-900000,oi:110}]}).oiChangePct,null);
    const ready=signal(f);eq(currentRetestSignal({...ready,supply:flow},f.asOf).plan,ready.plan);
  });
  test("new tab renders both directions, filters without affecting existing tabs, and explains missing frames",()=>{
    const f=fixture(), ready=signal(f), rows=[{symbol:"LONGUSDT",quoteVolume:1e7,price:100,trendRetest:ready},{symbol:"SHORTUSDT",quoteVolume:1e7,price:100,trendRetest:{...ready,direction:"short"}}];
    const html=retestTabHtml(rows,["5m","1h"],f.asOf);assert(html.includes("LONGUSDT")&&html.includes("SHORTUSDT"));assert(html.includes("비용 후 손익비"));
    assert(retestTabHtml([],[],f.asOf).includes("시간봉을 선택"));
    const handlers=new Map(), root={querySelectorAll:selector=>selector==="[data-retest-side]"?["both","long","short"].map(value=>({dataset:{retestSide:value},addEventListener(_e,fn){handlers.set(value,fn);}})):[]};
    bindRetestControls(root,()=>{});handlers.get("short")();
    assert(!retestTabHtml(rows,["5m","1h"],f.asOf).includes("LONGUSDT"));
    handlers.get("both")();
  });
}
