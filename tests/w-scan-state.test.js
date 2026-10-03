import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activePatterns,scanJobs,isStale,trendLabel} from '../js/core/w-scan-state.js';
test('ranking changes retain an active watch or target without duplicating discovery jobs',()=>{
 const records=new Map([['OLD:15m',{key:'OLD:15m',sym:'OLD',tf:'15m',candidates:[{stage:'WATCH'}]}],['DONE:1h',{key:'DONE:1h',sym:'DONE',tf:'1h',candidates:[]}]]);
 const jobs=scanJobs(['NEW'],records,new Set(['NEW','OLD','DONE']));
 assert.deepEqual(jobs.map(j=>j.key),['NEW:15m','NEW:1h','OLD:15m']);assert.equal(jobs[2].tracked,true);
 assert.equal(scanJobs(['OLD'],records,new Set(['OLD'])).length,2);
});
test('delisted contracts are never kept in the scan queue',()=>{
 const r={sym:'OLD',tf:'1h',key:'OLD:1h',candidates:[{stage:'TARGET'}]};assert.equal(scanJobs([],new Map([[r.key,r]]),new Set()).length,0);
});
test('all candidate states are exposed and legacy single results remain supported',()=>{
 assert.equal(activePatterns({candidates:[{stage:'WATCH'},{stage:'TARGET'}]}).length,2);assert.equal(activePatterns({active:{stage:'WATCH'}}).length,1);
});
test('outdated candles become stale on the clock even without another scan',()=>{
 const r={tf:'15m',c:[{t:0}]};assert.equal(isStale(r,900000+7000),false);assert.equal(isStale(r,1800000+7000),true);assert.equal(isStale({...r,error:'network'},900000),true);
});
test('hour context is advisory and needs sufficient bars',()=>{
 assert.match(trendLabel([]),/대기/);assert.match(trendLabel(Array.from({length:30},(_,i)=>({c:100+i}))),/상승/);assert.match(trendLabel(Array.from({length:30},(_,i)=>({c:100-i}))),/하락/);
});
