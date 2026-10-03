import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initWRadarTab } from '../js/ui/w-radar-tab.js';

function setup() {
  const messages=[],events={},loads={};let paused=0,resumed=0,mainBusy=false,auto=true;
  const frame={dataset:{src:'./w-radar.html'},contentWindow:{postMessage:(data,origin)=>messages.push({data,origin})},addEventListener:(name,fn)=>loads[name]=fn};
  const win={location:{origin:'https://ddanghae.github.io'},addEventListener:(name,fn)=>events[name]=fn};
  const tab=initWRadarTab({document:{getElementById:()=>frame},window:win,isMainBusy:()=>mainBusy,pauseMain:()=>paused++,resumeMain:()=>resumed++,shouldResumeMain:()=>auto});
  const send=(data,source=frame.contentWindow,origin=win.location.origin)=>events.message({data,source,origin});
  return {tab,frame,messages,send,loads,get paused(){return paused;},get resumed(){return resumed;},set mainBusy(v){mainBusy=v;},set auto(v){auto=v;}};
}
test('W view loads lazily using a project-relative URL and stays mounted',()=>{
 const x=setup();assert.equal(x.frame.src,undefined);x.tab.select(true);assert.equal(x.frame.src,'./w-radar.html');assert.equal(x.paused,1);
 x.tab.select(false);assert.equal(x.frame.src,'./w-radar.html');assert.equal(x.resumed,1);
 x.tab.select(true);assert.equal(x.messages.at(-1).data.active,true);
});
test('in-flight W scan defers main auto-refresh after leaving the tab',()=>{
 const x=setup();x.tab.select(true);x.send({type:'qar:w-busy',busy:true});x.tab.select(false);assert.equal(x.resumed,0);assert.equal(x.tab.isBusy(),true);
 x.send({type:'qar:w-busy',busy:false});assert.equal(x.resumed,1);assert.equal(x.tab.isBlocking(),false);
});
test('host reports main scan status and rejects messages from other origins/windows',()=>{
 const x=setup();x.tab.select(true);x.mainBusy=true;x.tab.sync();assert.equal(x.messages.at(-1).data.mainBusy,true);
 x.send({type:'qar:w-busy',busy:true},{},'https://ddanghae.github.io');assert.equal(x.tab.isBusy(),false);
 x.send({type:'qar:w-busy',busy:true},x.frame.contentWindow,'https://example.org');assert.equal(x.tab.isBusy(),false);
});
test('returning does not enable auto-refresh when user disabled it',()=>{
 const x=setup();x.auto=false;x.tab.select(true);x.tab.select(false);assert.equal(x.resumed,0);
});
test('child ready and reload restore active context without duplicate scheduling',()=>{
 const x=setup();x.tab.select(true);x.send({type:'qar:w-ready'});x.loads.load();assert.equal(x.paused,1);assert.equal(x.messages.at(-1).data.active,true);
});
