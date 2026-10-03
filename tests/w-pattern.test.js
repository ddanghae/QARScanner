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
test('weak-volume breakout is filtered, never gets an entry price',()=>{const c=fixture();c[33].v=900;const r=Filtered.detect(c),p=r.history.find(p=>p.stage==='FILTERED');assert.ok(p.checks.some(x=>x.id==='volume'&&!x.pass));assert.equal(p.entry,undefined);});
test('long upper-wick breakout is filtered',()=>{const c=fixture();c[33].h=125;const p=Filtered.detect(c).history.find(p=>p.stage==='FILTERED');assert.ok(p.checks.some(x=>x.id==='close'&&!x.pass));});
test('huge breakout is not labeled as a fresh entry',()=>{const c=fixture();c[33].c=120;c[33].h=121;const p=Filtered.detect(c).history.find(p=>p.stage==='FILTERED');assert.ok(p.checks.some(x=>x.id==='extension'&&!x.pass));});
test('next close below neckline filters a bull trap before entry',()=>{const c=fixture();c[34].c=109;const p=Filtered.detect(c).history.find(p=>p.stage==='FILTERED');assert.ok(p.checks.some(x=>x.id==='hold'&&!x.pass));assert.equal(p.entry,undefined);});
test('post-entry neckline failure preserves entry history and invalidates',()=>{const c=fixture();c.push({t:35*900000,end:36*900000-1,o:112,h:112.2,l:108.5,c:109,v:1000});const p=Filtered.detect(c).history.find(p=>p.entry);assert.equal(p.stage,'INVALID');assert.match(p.reason,/넥라인/);assert.equal(p.entry,112);assert.ok(p.events.some(e=>e.type==='ENTRY'));});
test('too shallow second V cannot become TARGET',()=>{const c=fixture();for(let i=28;i<=32;i++){c[i].o=109;c[i].c=109.2;c[i].h=109.4;c[i].l=108.8;}c[30].l=108.7;c[32].c=109.8;c[32].h=110;const r=Filtered.detect(c);assert.ok(!r.active?.entry);assert.ok(r.history.some(p=>p.stage==='FILTERED'&&p.checks.some(x=>x.id==='bottoms'&&!x.pass)));});
test('shape validation rejects lopsided timing and extra bottoms',()=>{const c=fixture(),p=E.detect(c.slice(0,33)).active;const unbalanced=Filtered.shapeChecks(c,{...p,neckIndex:p.l1Index+1});assert.ok(unbalanced.some(x=>x.id==='balance'&&!x.pass));const extra=fixture();extra[26].l=100.5;const checks=Filtered.shapeChecks(extra,{...p});assert.ok(checks.some(x=>x.id==='multiple'&&!x.pass));});
test('height filter rejects volatility-sized noise',()=>{const c=fixture(),p=E.detect(c.slice(0,33)).active;const checks=Filtered.shapeChecks(c,{...p,atr:20});assert.ok(checks.some(x=>x.id==='height'&&!x.pass));assert.ok(checks.some(x=>x.id==='depth'&&!x.pass));});
test('continuation W is explicitly classified and can be disabled',()=>{const c=fixture();for(let i=0;i<20;i++){c[i].c=100+i*.5;c[i].o=c[i].c-.4;c[i].h=c[i].c+.3;c[i].l=c[i].o-.3;}const p=E.detect(c.slice(0,33)).active;assert.ok(p);const clone={...p};const checks=Filtered.shapeChecks(c,clone,{allowContinuation:false});assert.equal(clone.context,'CONTINUATION');assert.ok(checks.some(x=>x.id==='context'&&!x.pass));});
test('filtered events are causal across every prefix',()=>{const c=fixture(),p=Filtered.detect(c).active;for(let n=24;n<=c.length;n++){const r=Filtered.detect(c.slice(0,n));if(r.active?.id===p.id)assert.deepEqual(r.active.events,p.events.filter(e=>e.time<=c[n-1].end));}});
test('filtered decisions are unchanged by asset price scale',()=>{const c=fixture(),small=c.map(b=>({...b,o:b.o/1e5,h:b.h/1e5,l:b.l/1e5,c:b.c/1e5}));assert.equal(Filtered.detect(small).active.stage,'ENTRY');});
test('filtered equal lows preserve the user support rule',()=>{const c=fixture().slice(0,33);c[30].l=c[22].l;assert.equal(Filtered.detect(c).active.stage,'TARGET');});
test('third support test after TARGET is excluded before breakout',()=>{const c=fixture().slice(0,33);c[32].c=108;c[32].h=108.35;const tail=candles([108,104,102,104,106]).slice(1);tail.forEach((b,k)=>c.push({...b,t:(33+k)*900000,end:(34+k)*900000-1}));const r=Filtered.detect(c);assert.ok(r.history.some(p=>p.stage==='FILTERED'&&p.checks.some(x=>x.id==='thirdLow'&&!x.pass)));});
test('zero historical volume cannot manufacture volume confirmation',()=>{const c=fixture().map(b=>({...b,v:0}));c[33].v=100;const p=Filtered.detect(c).history.find(p=>p.stage==='FILTERED');assert.ok(p.checks.some(x=>x.id==='volume'&&!x.pass));});
test('higher price on confirmation bar is also checked for chasing',()=>{const c=fixture();c[34].c=115;c[34].h=115.3;const p=Filtered.detect(c).history.find(p=>p.stage==='FILTERED');assert.ok(p.checks.some(x=>x.id==='confirmExtension'&&!x.pass));assert.equal(p.entry,undefined);});
test('minor zigzags in a rising leg are not mistaken for an extra bottom',()=>{const c=candles([...Array(20).fill(110),107,103,100,101,102,103,104,101.5,103,106,110,108,105,103,102,104,106]);const p={l1Index:22,l1:99.65,l2Index:34,l2:101.65,neckIndex:30,neck:110.35,peakIndex:19,atr:1.5};const checks=Filtered.shapeChecks(c,p);assert.ok(checks.find(x=>x.id==='multiple').pass);});
