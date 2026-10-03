import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Filtered from '../js/core/w-pattern.js';
// Preserve regression coverage for the explicitly available unfiltered mode.
const E={...Filtered,detect:(c,o={})=>Filtered.detect(c,{filters:false,...o})};
function candles(levels){let previous=levels[0];return levels.map((v,i)=>{const o=previous;previous=v;return {t:i*900000,end:(i+1)*900000-1,o,h:Math.max(o,v)+.35,l:Math.min(o,v)-.35,c:v,v:i===33?2100:1000};});}
function fixture(){return candles([...Array.from({length:20},(_,i)=>110+Math.sin(i)*.12),107,103,100,102,104,107,110,108,105,103,102,104,106,111,112]);}
test('first V is WATCH, supported second V is TARGET, W breakout is ENTRY',()=>{
 const c=fixture();assert.equal(E.detect(c.slice(0,25)).active,null);
 const w=E.detect(c.slice(0,27)).active;assert.equal(w.stage,'WATCH');assert.equal(w.l2,undefined);assert.equal(w.entry,undefined);
 const t=E.detect(c.slice(0,33)).active;assert.equal(t.stage,'TARGET');assert.ok(t.l2>=t.l1);assert.equal(t.entry,undefined);
 const e=E.detect(c.slice(0,34)).active;assert.equal(e.stage,'ENTRY');assert.equal(e.entry,111);assert.equal(e.entryTime,c[33].end);assert.equal(e.volumeRatio,2.1);assert.deepEqual(e.events.map(e=>e.type),['WATCH','TARGET','ENTRY']);
});
test('wick below first V invalidates even when close recovers',()=>{
 const c=fixture().slice(0,33);c[30].l=99;const r=E.detect(c);assert.ok(r.history.some(p=>p.stage==='INVALID'&&p.l1Index===22));assert.ok(!r.active||r.active.l1Index!==22);
});
test('equal lows remain valid',()=>{const c=fixture().slice(0,33);c[30].l=c[22].l;assert.equal(E.detect(c).active.stage,'TARGET');});
test('target wick below L2 on breakout candle wins over entry',()=>{const c=fixture().slice(0,34);c[33].l=c[30].l-.1;const r=E.detect(c);assert.ok(r.history.some(p=>p.stage==='INVALID'));assert.ok(!r.history.some(p=>p.entry));assert.ok(!r.active?.entry);});
test('wick above neckline without close is not a completed W',()=>{const c=fixture().slice(0,34);c[33].h=114;c[33].c=110;assert.equal(E.detect(c).active.stage,'TARGET');});
test('second low is not recognized before its two confirming bars',()=>{const r=E.detect(fixture().slice(0,32));assert.equal(r.active.stage,'WATCH');});
test('signal age expires and retains event history',()=>{const c=fixture();for(let i=c.length;i<49;i++)c.push({t:i*900000,end:(i+1)*900000-1,o:112,h:113,l:111,c:112,v:1000});const r=E.detect(c);assert.ok(r.history.some(p=>p.stage==='EXPIRED'&&p.entry===111));});
test('future candles cannot move already emitted event times',()=>{const c=fixture(),events=E.detect(c).active.events;for(let n=24;n<c.length;n++){const r=E.detect(c.slice(0,n));if(r.active&&r.active.l1Index===22)assert.deepEqual(r.active.events,events.filter(e=>e.time<=c[n-1].end));}});
test('closed candle filter excludes forming bars',()=>{const raw=[[0,'1','2','.5','1.5','10',899999],[900000,'1','2','.5','1.5','10',1799999]];assert.equal(E.fromRaw(raw,1000000).length,1);});
test('gaps fail validation instead of inventing a pattern',()=>{const c=candles(Array(45).fill(100));c.splice(20,1);assert.throws(()=>E.validate(c,900000),/누락/);});
test('scale invariance for low-priced coins',()=>{const c=fixture(),small=c.map(b=>({...b,o:b.o*.0001,h:b.h*.0001,l:b.l*.0001,c:b.c*.0001}));assert.equal(E.detect(small).active.stage,'ENTRY');});
test('slow first V recovery is retained until it completes',()=>{const c=fixture();assert.equal(E.detect(c.slice(0,25)).active,null);assert.equal(E.detect(c.slice(0,26)).active.stage,'WATCH');});
test('filtered W waits one more closed candle and uses actual confirmation price',()=>{
 const c=fixture(),pending=Filtered.detect(c.slice(0,34)).active;assert.equal(pending.stage,'TARGET');assert.equal(pending.pending,true);assert.equal(pending.entry,undefined);
 const p=Filtered.detect(c).active;assert.equal(p.stage,'ENTRY');assert.equal(p.entry,112);assert.equal(p.entryTime,c[34].end);assert.equal(p.breakoutPrice,111);assert.ok(p.checks.every(x=>!x.required||x.pass));
});
test('weak-volume breakout waits for another attempt without an entry',()=>{const c=fixture();c[33].v=900;const p=Filtered.detect(c).active;assert.equal(p.stage,'TARGET');assert.ok(p.attempts[0].checks.some(x=>x.id==='volume'&&!x.pass));assert.equal(p.entry,undefined);});
test('long upper-wick breakout waits without manufacturing an entry',()=>{const c=fixture();c[33].h=125;const p=Filtered.detect(c).active;assert.ok(p.attempts[0].checks.some(x=>x.id==='close'&&!x.pass));assert.equal(p.entry,undefined);});
test('huge breakout is not labeled as a fresh entry',()=>{const c=fixture();c[33].c=120;c[33].h=121;const p=Filtered.detect(c).history.find(p=>p.stage==='MISSED');assert.ok(p.checks.some(x=>x.id==='extension'&&!x.pass));});
test('next close below neckline returns to bounded retry without entry',()=>{const c=fixture();c[34].c=109;const p=Filtered.detect(c).active;assert.equal(p.stage,'TARGET');assert.equal(p.pending,false);assert.ok(p.attempts[0].checks.some(x=>x.id==='hold'&&!x.pass));assert.equal(p.entry,undefined);});
test('post-entry neckline failure preserves entry history and invalidates',()=>{const c=fixture();c.push({t:35*900000,end:36*900000-1,o:112,h:112.2,l:108.5,c:109,v:1000});const p=Filtered.detect(c).history.find(p=>p.entry);assert.equal(p.stage,'INVALID');assert.match(p.reason,/넥라인/);assert.equal(p.entry,112);assert.ok(p.events.some(e=>e.type==='ENTRY'));});
test('too shallow second V cannot become TARGET',()=>{const c=fixture();for(let i=28;i<=32;i++){c[i].o=109;c[i].c=109.2;c[i].h=109.4;c[i].l=108.8;}c[30].l=108.7;c[32].c=109.8;c[32].h=110;const r=Filtered.detect(c);assert.ok(!r.active?.entry);assert.ok(r.history.some(p=>p.stage==='FILTERED'&&p.checks.some(x=>x.id==='bottoms'&&!x.pass)));});
test('shape validation rejects lopsided timing and extra bottoms',()=>{const c=fixture(),p=E.detect(c.slice(0,33)).active;const unbalanced=Filtered.shapeChecks(c,{...p,neckIndex:p.l1Index+1});assert.ok(unbalanced.some(x=>x.id==='balance'&&!x.pass));const extra=fixture();extra[26].l=100.5;const checks=Filtered.shapeChecks(extra,{...p});assert.ok(checks.some(x=>x.id==='multiple'&&!x.pass));});
test('height filter rejects volatility-sized noise',()=>{const c=fixture(),p=E.detect(c.slice(0,33)).active;const checks=Filtered.shapeChecks(c,{...p,atr:20});assert.ok(checks.some(x=>x.id==='height'&&!x.pass));assert.ok(checks.some(x=>x.id==='depth'&&!x.pass));});
test('continuation W is explicitly classified and can be disabled',()=>{const c=fixture();for(let i=0;i<20;i++){c[i].c=100+i*.5;c[i].o=c[i].c-.4;c[i].h=c[i].c+.3;c[i].l=c[i].o-.3;}const p=E.detect(c.slice(0,33)).active;assert.ok(p);const clone={...p};const checks=Filtered.shapeChecks(c,clone,{allowContinuation:false});assert.equal(clone.context,'CONTINUATION');assert.ok(checks.some(x=>x.id==='context'&&!x.pass));});
test('continuation W cannot use a much higher second bottom to pass as a W',()=>{const c=fixture();for(let i=0;i<20;i++){c[i].c=100+i*.5;c[i].o=c[i].c-.4;c[i].h=c[i].c+.3;c[i].l=c[i].o-.3;}const p=E.detect(c.slice(0,33)).active;const height=p.neck-p.l1,checks=Filtered.shapeChecks(c,{...p,l2:p.l1+height*.49});assert.ok(checks.some(x=>x.id==='bottoms'&&!x.pass));assert.match(checks.find(x=>x.id==='bottoms').value,/최대 25%/);});
test('target structure draws both valleys, the intervening neckline and right-side rebound in order',()=>{const c=fixture().slice(0,33),p=Filtered.detect(c).active;assert.equal(p.stage,'TARGET');assert.ok(p.bounceIndex>=p.l2Index);assert.deepEqual(Filtered.structurePoints(c,p).map(x=>x[0]),[p.peakIndex,p.l1Index,p.neckIndex,p.l2Index,p.bounceIndex]);});
test('filtered events are causal across every prefix',()=>{const c=fixture(),p=Filtered.detect(c).active;for(let n=24;n<=c.length;n++){const r=Filtered.detect(c.slice(0,n));if(r.active?.id===p.id)assert.deepEqual(r.active.events,p.events.filter(e=>e.time<=c[n-1].end));}});
test('filtered decisions are unchanged by asset price scale',()=>{const c=fixture(),small=c.map(b=>({...b,o:b.o/1e5,h:b.h/1e5,l:b.l/1e5,c:b.c/1e5}));assert.equal(Filtered.detect(small).active.stage,'ENTRY');});
test('filtered equal lows preserve the user support rule',()=>{const c=fixture().slice(0,33);c[30].l=c[22].l;assert.equal(Filtered.detect(c).active.stage,'TARGET');});
test('third support test after TARGET is excluded before breakout',()=>{const c=fixture().slice(0,33);c[32].c=108;c[32].h=108.35;const tail=candles([108,104,102,104,106]).slice(1);tail.forEach((b,k)=>c.push({...b,t:(33+k)*900000,end:(34+k)*900000-1}));const r=Filtered.detect(c);assert.ok(r.history.some(p=>p.stage==='FILTERED'&&p.checks.some(x=>x.id==='thirdLow'&&!x.pass)));});
test('zero historical volume cannot manufacture volume confirmation',()=>{const c=fixture().map(b=>({...b,v:0}));c[33].v=100;const p=Filtered.detect(c).active;assert.ok(p.attempts[0].checks.some(x=>x.id==='volume'&&!x.pass));});
test('higher price on confirmation bar is also checked for chasing',()=>{const c=fixture();c[34].c=115;c[34].h=115.3;const p=Filtered.detect(c).history.find(p=>p.stage==='MISSED');assert.ok(p.checks.some(x=>x.id==='confirmExtension'&&!x.pass));assert.equal(p.entry,undefined);});
test('minor zigzags in a rising leg are not mistaken for an extra bottom',()=>{const c=candles([...Array(20).fill(110),107,103,100,101,102,103,104,101.5,103,106,110,108,105,103,102,104,106]);const p={l1Index:22,l1:99.65,l2Index:34,l2:101.65,neckIndex:30,neck:110.35,peakIndex:19,atr:1.5};const checks=Filtered.shapeChecks(c,p);assert.ok(checks.find(x=>x.id==='multiple').pass);});

function append(c,o,h,l,close,v=1000){const i=c.length;c.push({t:i*900000,end:(i+1)*900000-1,o,h,l,c:close,v});return c;}
function original(result){return [...result.candidates,...result.history].find(p=>p.l1Index===22);}

test('slow second V recovery retains the already confirmed low',()=>{
 const c=fixture().slice(0,31);
 append(c,102,102.4,101.8,102.1);append(c,102.1,102.4,101.9,102.2);
 assert.equal(original(Filtered.detect(c)).stage,'WATCH');
 append(c,102.2,104.5,102,104);
 const p=original(Filtered.detect(c));assert.equal(p.stage,'TARGET');assert.equal(p.l2Index,30);assert.equal(p.targetIndex,33);
});
test('weak first breakout can become an entry on a later strong attempt',()=>{
 const c=fixture().slice(0,34);c[33].v=700;
 append(c,111,111.3,108.8,109);append(c,109,112.3,108.9,112,2400);append(c,112,112.5,111,112.2);
 const p=original(Filtered.detect(c));assert.equal(p.stage,'ENTRY');assert.equal(p.entryIndex,36);assert.equal(p.attempts.length,1);assert.ok(p.events.some(e=>e.type==='RETRY'));assert.ok(p.checks.every(x=>!x.required||x.pass));
});
test('retry has a deadline and L1 wick invalidation still takes precedence',()=>{
 const c=fixture().slice(0,34);c[33].v=700;
 for(let k=0;k<8;k++)append(c,109,109.5,108,109);
 assert.equal(original(Filtered.detect(c)).stage,'EXPIRED');
 const d=fixture().slice(0,34);d[33].v=700;append(d,111,112,99,111);
 assert.equal(original(Filtered.detect(d)).stage,'INVALID');
});
test('at most three failed breakout attempts are accepted',()=>{
 const c=fixture().slice(0,34);c[33].v=700;
 for(let k=0;k<2;k++){append(c,111,111.2,108.8,109);append(c,109,111.3,108.9,111,100);}
 const p=original(Filtered.detect(c));assert.equal(p.stage,'EXPIRED');assert.equal(p.attempts.length,3);
});
test('L2 can reform above L1 before an entry but cannot confirm on the breach bar',()=>{
 const c=fixture().slice(0,33);append(c,106,106.2,101,101.5);
 let p=original(Filtered.detect(c));assert.equal(p.stage,'WATCH');assert.equal(p.entry,undefined);assert.equal(p.resets,1);
 append(c,101.5,103.5,101.3,103);append(c,103,106,102,105);
 p=original(Filtered.detect(c));assert.equal(p.stage,'TARGET');assert.equal(p.l2,101);assert.equal(p.l1,99.65);assert.equal(p.targetIndex,35);
});
test('post-entry L2 protection is never relaxed',()=>{
 const c=fixture();append(c,112,112.2,101,111);
 assert.equal(original(Filtered.detect(c)).stage,'INVALID');
});
test('close holding above neckline is not falsely called a retest',()=>{
 const c=fixture();append(c,112,113,111.5,112.5);
 let p=original(Filtered.detect(c));assert.equal(p.stage,'ENTRY');assert.equal(p.retestTime,undefined);
 append(c,111,111.6,110.4,111.4);
 p=original(Filtered.detect(c));assert.equal(p.retestTime,c.at(-1).end);assert.equal(p.retestPrice,111.4);assert.equal(p.entryTime,c[34].end);
});
test('a deep neckline breach is not a successful retest',()=>{
 const c=fixture();append(c,111,111.5,108,111.2);assert.equal(original(Filtered.detect(c)).retestTime,undefined);
});
test('independent first V candidates can coexist with an existing pattern',()=>{
 const c=fixture();const r=Filtered.detect(c);assert.ok(r.candidates.length>=2);assert.ok(r.candidates.some(p=>p.l1Index===22));assert.ok(r.candidates.some(p=>p.l1Index===30));assert.equal(r.active.stage,'ENTRY');
});
test('duplicate second troughs produce one representative and candidate count stays bounded',()=>{
 const p={stage:'TARGET',l2Index:30,l1Index:20,events:[{time:50}]};
 assert.equal(Filtered.visibleCandidates([p,{...p,l1Index:22}]).length,1);
 assert.ok(Filtered.detect(fixture(),{maxCandidates:1}).candidates.length<=1);
});
test('retry, support reset and retest events remain prefix-causal across all candidates',()=>{
 const c=fixture().slice(0,34);c[33].v=700;append(c,111,111.3,108.8,109);append(c,109,112.3,108.9,112,2400);append(c,112,112.5,111,112.2);append(c,111,111.6,110.4,111.4);
 const full=Filtered.detect(c);
 for(let n=24;n<=c.length;n++)for(const p of [...Filtered.detect(c.slice(0,n)).candidates,...Filtered.detect(c.slice(0,n)).history]){
  const final=[...full.candidates,...full.history].find(x=>x.id===p.id);
  if(final)assert.deepEqual(p.events,final.events.filter(e=>e.time<=c[n-1].end));
 }
});
test('timeframe profiles are separate and overrides do not mutate defaults',()=>{
 const m=Filtered.optionsFor('15m',{retryBars:4}),h=Filtered.optionsFor('1h');assert.equal(m.retryBars,4);assert.equal(h.retryBars,6);assert.notEqual(Filtered.profiles['15m'],Filtered.profiles['1h']);
});
test('negative volume rows are rejected as invalid data',()=>{
 assert.equal(Filtered.fromRaw([[0,'1','2','.5','1.5','-1',899999]],1000000).length,0);
});

test('a pending breakout cannot become an entry after L2 has been broken',()=>{
 const c=fixture().slice(0,34);append(c,111,112,101,111.5);
 const p=original(Filtered.detect(c));assert.equal(p.stage,'WATCH');assert.equal(p.pending,false);assert.equal(p.entry,undefined);
});
test('the second-bottom reformation budget expires instead of lowering L1 indefinitely',()=>{
 const c=fixture().slice(0,33);append(c,106,106.2,101,101.5);append(c,101.5,103.5,101.3,103);append(c,103,106,102,105);append(c,105,105.2,100.5,101);
 const p=original(Filtered.detect(c,{maxResets:1}));assert.equal(p.stage,'EXPIRED');assert.equal(p.l1,99.65);assert.equal(p.entry,undefined);
});
test('a saved slow second low is invalidated before recovery if L1 breaks',()=>{
 const c=fixture().slice(0,31);append(c,102,102.4,101.8,102.1);append(c,102.1,102.4,101.9,102.2);append(c,102.2,104.5,99,104);
 const p=original(Filtered.detect(c));assert.equal(p.stage,'INVALID');assert.equal(p.entry,undefined);
});

test('entry freezes L2 stop and three distinct 1R/2R/3R targets',()=>{
 const p=original(Filtered.detect(fixture())),l=p.levels;
 assert.equal(l.entry,112);assert.equal(l.stop,101.65);assert.equal(l.risk,112-101.65);
 assert.deepEqual(l.targets.map(t=>t.label),['TP1','TP2','TP3']);
 for(let i=0;i<3;i++){assert.equal(l.targets[i].price,l.entry+(i+1)*l.risk);assert.equal(l.targets[i].r,i+1);assert.equal(l.targets[i].percent,100*(i+1)*l.risk/l.entry);}
 assert.equal(l.riskPercent,100*l.risk/l.entry);
});
test('watch and target never expose unconfirmed trade levels',()=>{
 for(const n of [27,33,34]){const p=original(Filtered.detect(fixture().slice(0,n)));assert.equal(p.levels,undefined);}
});
test('levels remain unchanged after future candles and pattern invalidation',()=>{
 const c=fixture(),before=structuredClone(original(Filtered.detect(c)).levels);
 append(c,112,113,111,112.5);assert.deepEqual(original(Filtered.detect(c)).levels,before);
 append(c,112,113,99,100);const p=original(Filtered.detect(c));assert.equal(p.stage,'INVALID');assert.deepEqual(p.levels,before);
});
test('retest gets its own entry based levels without moving the original plan',()=>{
 const c=fixture(),before=structuredClone(original(Filtered.detect(c)).levels);
 append(c,111,111.6,110.4,111.4);const p=original(Filtered.detect(c));assert.deepEqual(p.levels,before);
 assert.equal(p.retestLevels.entry,111.4);assert.equal(p.retestLevels.stop,p.l2);assert.equal(p.retestLevels.targets[2].price,111.4+3*(111.4-p.l2));
});
test('invalid or zero risk cannot manufacture target levels',()=>{
 for(const [entry,l2] of [[100,100],[99,100],[100,0],[100,-1],[NaN,90],[100,Infinity],[Infinity,100],[Number.MAX_VALUE,1]])assert.equal(Filtered.tradeLevels({entry,l2}),null);
});
test('low-priced assets preserve percentage risk and target ordering',()=>{
 const small=Filtered.tradeLevels({entry:.000012,l2:.00001}),big=Filtered.tradeLevels({entry:12,l2:10});
 assert.ok(Math.abs(small.riskPercent-big.riskPercent)<1e-10);
 const prices=[small.stop,small.entry,...small.targets.map(t=>t.price)];for(let i=1;i<prices.length;i++)assert.ok(prices[i]>prices[i-1]);
});
test('unfiltered entries also carry the same structural risk plan',()=>{
 const p=original(E.detect(fixture().slice(0,34)));assert.equal(p.levels.entry,111);assert.equal(p.levels.stop,p.l2);assert.equal(p.levels.targets.length,3);
});
