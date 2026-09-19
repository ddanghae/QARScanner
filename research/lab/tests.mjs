import test from 'node:test';
import assert from 'node:assert/strict';
import { quality,aggregate,STEP,DAY,validateConfig } from './data.mjs';
import { simulate,summarize,splits } from './engine.mjs';
import { prefix,windows,candidates,isNew4hClose } from './strategies.mjs';
import { CONFIG } from '../../js/config.js';
import { buildEarlyMetrics } from '../../js/core/early-detect.js';
import { analyzeCandles } from '../../js/scanner/deep-scanner.js';

const config={symbols:['BTCUSDT'],start:'2026-01-01T00:00:00Z',end:'2026-04-01T00:00:00Z',warmupDays:40,
  evaluationMinutes:5,holdHours:1,feeBpsPerSide:5,slippageBpsPerSide:5,splitFractions:[0.6,0.2,0.2],reversalMinScore:30,minResolvedTrades:30};
const bar=(i,o=100,h=105,l=95,c=100)=>({openTime:i*STEP,closeTime:(i+1)*STEP-1,open:o,high:h,low:l,close:c,
  volume:100,quoteVolume:10000,trades:100,takerBuyBase:50,takerBuyQuote:5000,takerSellBase:50});
const signal=(patch={})=>({symbol:'TESTUSDT',direction:'long',signalTime:STEP-1,
  plan:{entry:100,invalidation:90,tp1:110,tp2:120,partialFrac:0},...patch});

test('config rejects duplicate symbols, bad time partitions and negative costs',()=>{
  assert.equal(validateConfig(config),config);
  assert.throws(()=>validateConfig({...config,symbols:['BTCUSDT','BTCUSDT']}));
  assert.throws(()=>validateConfig({...config,start:'2026-01-01T00:01:00Z'}));
  assert.throws(()=>validateConfig({...config,splitFractions:[0.5,0.2,0.2]}));
  assert.throws(()=>validateConfig({...config,feeBpsPerSide:-1}));
});
test('quality reports gaps, duplicates, invalid OHLC and coverage',()=>{
  const good=[bar(0),bar(1),bar(2)];assert.equal(quality(good,0,3*STEP).ok,true);
  assert.equal(quality([bar(0),bar(2)],0,3*STEP).missing,1);
  assert.equal(quality([bar(0),bar(2)],0,3*STEP).gaps,1);
  assert.equal(quality([bar(0),bar(0)],0,2*STEP).duplicates,1);
  assert.equal(quality([bar(0,100,99,95,100)],0,STEP).invalid,1);
});
test('aggregation uses UTC complete groups and additive volume only',()=>{
  const input=Array.from({length:7},(_,i)=>bar(i,100+i,106+i,95+i,101+i));
  const a=aggregate(input,3*STEP);
  assert.equal(a.length,2);assert.equal(a[0].openTime,0);assert.equal(a[0].closeTime,3*STEP-1);
  assert.equal(a[0].open,100);assert.equal(a[0].close,103);assert.equal(a[0].high,108);assert.equal(a[0].volume,300);
  assert.equal(aggregate(input.filter((_,i)=>i!==1),3*STEP).length,1);
});
test('future bars are not included by prefix or available windows',()=>{
  const rows=Array.from({length:100},(_,i)=>bar(i));
  assert.equal(prefix(rows,10*STEP).length,10);
  assert.equal(prefix(rows,10*STEP,3)[0].openTime,7*STEP);
  const s={k5m:rows,k15m:aggregate(rows,3*STEP),k1h:aggregate(rows,12*STEP),k4h:aggregate(rows,48*STEP)};
  const w=windows(s,49*STEP);
  assert.equal(w.k4h.length,1);assert.equal(w.k1h.length,4);
  assert.ok(Object.values(w).flat().every(c=>c.closeTime<49*STEP));
});
test('long and short outcomes are symmetric and include costs',()=>{
  const a=simulate(signal(),[bar(1,100,121,99,120)],config);
  assert.equal(a.status,'TARGET');assert.equal(a.netPct,19.8);assert.equal(a.r,1.98);
  const b=simulate(signal({direction:'short',plan:{invalidation:110,tp1:90,tp2:80,partialFrac:0}}),[bar(1,100,101,79,80)],config);
  assert.equal(b.r,a.r);
});
test('next-open entry, gap stop and market-invalid plans do not fabricate fills',()=>{
  const stopped=simulate(signal(),[bar(1),bar(2,85,89,80,85)],config);
  assert.equal(stopped.status,'STOP');assert.equal(stopped.exitPrice,85);assert.equal(stopped.netPct,-15.2);
  const changed=simulate(signal(),[bar(1,102,121,101,120)],config);
  assert.equal(changed.entry,102);
  assert.equal(simulate(signal(),[bar(1,125,130,124,126)],config).status,'INVALID_PLAN');
});
test('same-bar stop/target and partial/breakeven uncertainty are explicit',()=>{
  assert.equal(simulate(signal(),[bar(1,100,121,89,100)],config).status,'AMBIGUOUS');
  const partial=signal({plan:{invalidation:90,tp1:110,tp2:120,partialFrac:0.5}});
  assert.equal(simulate(partial,[bar(1,100,111,99,105)],config).status,'AMBIGUOUS');
});
test('partial exit plus final target and cost arithmetic',()=>{
  const s=signal({plan:{invalidation:90,tp1:110,tp2:120,partialFrac:0.5}});
  const r=simulate(s,[bar(1,100,106,100,105),bar(2,106,111,105,108),bar(3,108,121,105,120)],config);
  assert.equal(r.status,'TARGET');assert.equal(r.partialTaken,true);assert.equal(r.grossPct,15);assert.equal(r.r,1.48);
});
test('missing horizon, intermediate gaps and bad prices remain incomplete',()=>{
  assert.equal(simulate(signal(),[bar(1)],config).status,'INCOMPLETE');
  assert.equal(simulate(signal(),[bar(1),bar(3)],config).status,'INCOMPLETE');
  assert.equal(simulate(signal(),[bar(2)],config).status,'INCOMPLETE');
  assert.equal(simulate(signal(),[bar(1,100,NaN,95,100)],config).status,'INCOMPLETE');
});
test('time exit only at full horizon',()=>{
  const rows=Array.from({length:12},(_,i)=>bar(i+1));
  assert.equal(simulate(signal(),rows,config).status,'TIME');
  assert.equal(simulate(signal(),rows,config).netPct,-0.2);
});
test('summary excludes unresolved outcomes but shows their denominators',()=>{
  const rows=[{symbol:'A',status:'TARGET',r:2,netPct:2,exitTime:1},{symbol:'A',status:'STOP',r:-1,netPct:-1,exitTime:2},
    {status:'AMBIGUOUS',r:null},{status:'INCOMPLETE',r:null},{status:'INVALID_PLAN',r:null}];
  const s=summarize(rows,30);
  assert.equal(s.signals,5);assert.equal(s.resolved,2);assert.equal(s.coverage,0.4);
  assert.equal(s.meanR,0.5);assert.equal(s.winRate,0.5);assert.equal(s.profitFactor,2);
  assert.equal(s.tradeOrderDrawdownR,1);assert.equal(s.qualified,false);
  assert.equal(summarize([],30).winRate,null);
});
test('time partitions share boundaries and do not include warmup',()=>{
  const s=splits(config,{start:0,end:100*DAY});
  assert.equal(s[0].start,40*DAY);assert.equal(s[0].end,s[1].start);assert.equal(s[1].end,s[2].start);assert.equal(s[2].end,100*DAY);
});
test('early freshness uses the simulated clock, not current date',()=>{
  const rows=Array.from({length:240},(_,i)=>({...bar(i,100+i,106+i,95+i,101+i),openTime:i*48*STEP,closeTime:(i+1)*48*STEP-1}));
  const now=240*48*STEP;
  const m=buildEarlyMetrics(rows,[],null,{onboardDate:1,change24h:5,quoteVolume:1e8},CONFIG,now);
  assert.ok(Math.abs(m.ageDays-(now-1)/DAY)<1e-9);
});
test('early candidates only fire once at a new 4h close',()=>{
  const rows=Array.from({length:240*48},(_,i)=>bar(i));
  const k4h=aggregate(rows,48*STEP),close=k4h.at(-1).closeTime;
  assert.equal(isNew4hClose(k4h,close+1),true);
  assert.equal(isNew4hClose(k4h,close+1+STEP),false);
});
test('reversal core remains deterministic with explicitly supplied time',()=>{
  const rows=Array.from({length:240*48},(_,i)=>bar(i,100+Math.sin(i/50),106+Math.sin(i/50),95+Math.sin(i/50),101+Math.sin(i/50)));
  const s={meta:{onboardDate:1},k5m:rows,k15m:aggregate(rows,3*STEP),k1h:aggregate(rows,12*STEP),k4h:aggregate(rows,48*STEP)};
  const now=rows.at(-1).closeTime+1,w=windows(s,now);
  const item={symbol:'TESTUSDT',baseAsset:'TEST',quoteVolume:1e8,newListing:false};
  assert.deepEqual(analyzeCandles(item,{direction:'both'},w,[],now),analyzeCandles(item,{direction:'both'},w,[],now));
  const original=candidates('TESTUSDT',s.meta,w,now,config);
  s.k5m.push(bar(rows.length,1000,2000,500,1500));
  assert.deepEqual(candidates('TESTUSDT',s.meta,windows(s,now),now,config),original);
});
