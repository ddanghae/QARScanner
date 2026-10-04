'use strict';

// Causal cup-and-handle screening. Only confirmed pivots and closed candles are used.
const defaults=Object.freeze({pivot:2,minCupBars:12,maxCupBars:100,minHandleBars:3,maxHandleBars:24,maxCupDepth:.35,minCupDepth:.06,rimTolerance:.08,maxHandleDepth:.38,minHandleRetrace:.08,minVolumeRatio:1.4,minBodyRatio:.45,minClosePosition:.68,minPriorRise:.06,maxExtensionATR:1.5,maxCandidates:6,maxSignalAge:12,failureATR:.15});
const mean=a=>a.reduce((s,x)=>s+x,0)/(a.length||1);
function atrAt(c,i){const s=c.slice(Math.max(0,i-13),i+1);return mean(s.map((b,k)=>{const p=s[k-1];return p?Math.max(b.h-b.l,Math.abs(b.h-p.c),Math.abs(b.l-p.c)):b.h-b.l;}));}
function highPivot(c,i,p=2){if(i<p||i+p>=c.length)return false;for(let j=i-p;j<=i+p;j++)if(j!==i&&(c[j].h>c[i].h||(j<i&&c[j].h===c[i].h)))return false;return true;}
function lowPivot(c,i,p=2){if(i<p||i+p>=c.length)return false;for(let j=i-p;j<=i+p;j++)if(j!==i&&(c[j].l<c[i].l||(j<i&&c[j].l===c[i].l)))return false;return true;}
const check=(id,label,pass,value)=>({id,label,pass,value});
function levels(entry,stop,cupDepth){const risk=entry-stop;if(!(entry>stop&&stop>0&&risk>0))return null;return{entry,stop,risk,riskPercent:100*risk/entry,targets:[1,2,3].map(r=>({label:'TP'+r,r,price:entry+risk*r,percent:100*risk*r/entry})),measuredTarget:entry+cupDepth};}
function shape(c,left,bottom,right,handle,options={}){
 const o={...defaults,...options},rim=(c[left].h+c[right].h)/2,depth=rim-c[bottom].l,span=right-left,handleDepth=handle>=0?rim-c[handle].l:0,mid=bottom-left,bar=[];
 const p={leftIndex:left,bottomIndex:bottom,rightIndex:right,handleIndex:handle,cupLeft:c[left].h,cupRight:c[right].h,rim,cupBottom:c[bottom].l,cupDepth:depth,handleLow:handle>=0?c[handle].l:null,atr:atrAt(c,right)};
 const prior=left>=20?(c[left].h-c[left-20].c)/Math.max(c[left-20].c,1e-12):0;
 // Broad U: the floor persists in a region, instead of one narrow V-shaped spike.
 const floorBars=c.slice(Math.max(left+1,bottom-3),Math.min(right,bottom+4)).filter(x=>x.l<=c[bottom].l+depth*.22).length;
 const leftMonotone=c.slice(left+1,bottom+1).filter((x,i,a)=>!i||x.l<=a[i-1].l+depth*.18).length/Math.max(1,bottom-left);
 const rightMonotone=c.slice(bottom+1,right+1).filter((x,i,a)=>!i||x.h>=a[i-1].h-depth*.18).length/Math.max(1,right-bottom);
 bar.push(check('prior','선행 상승 흐름',prior>=o.minPriorRise,`${(prior*100).toFixed(1)}% / 최소 ${(o.minPriorRise*100).toFixed(0)}%`));
 bar.push(check('duration','컵 형성 기간',span>=o.minCupBars&&span<=o.maxCupBars,`${span}봉 / ${o.minCupBars}~${o.maxCupBars}봉`));
 bar.push(check('depth','컵 깊이',depth/rim>=o.minCupDepth&&depth/rim<=o.maxCupDepth,`${(100*depth/rim).toFixed(1)}% / ${(100*o.minCupDepth).toFixed(0)}~${(100*o.maxCupDepth).toFixed(0)}%`));
 bar.push(check('rims','양쪽 림 높이',Math.abs(c[left].h-c[right].h)/depth<=o.rimTolerance,`${(100*Math.abs(c[left].h-c[right].h)/depth).toFixed(1)}% / 컵 깊이의 ${(100*o.rimTolerance).toFixed(0)}% 이내`));
 bar.push(check('bottomPosition','바닥 위치',mid/span>=.3&&mid/span<=.7,`컵 진행 ${(100*mid/span).toFixed(0)}% / 30~70%`));
 bar.push(check('roundness','둥근 바닥',floorBars>=3&&leftMonotone>=.45&&rightMonotone>=.45,`바닥 근접 ${floorBars}봉 · 하락/회복 형태 확인`));
 if(handle>=0){const hSpan=c.length-1-right,rel=handleDepth/depth;bar.push(check('handleDuration','핸들 기간',hSpan>=o.minHandleBars&&hSpan<=o.maxHandleBars,`${hSpan}봉 / ${o.minHandleBars}~${o.maxHandleBars}봉`));bar.push(check('handleDepth','얕은 핸들',rel>=o.minHandleRetrace&&rel<=o.maxHandleDepth&&c[handle].l>c[bottom].l+depth*.5,`컵 깊이의 ${(rel*100).toFixed(0)}% 되돌림 / 최대 ${(o.maxHandleDepth*100).toFixed(0)}%, 상단 절반 유지`));}
 return{pattern:p,checks:bar,pass:bar.every(x=>x.pass)};
}
// Replay each formation in time order. Entry prices and supports are frozen.
function detect(c,options={}){
 const o={...defaults,...options},candidates=[],history=[];
 if(!Array.isArray(c)||c.length<o.minCupBars+o.pivot+2)return{active:null,candidates,history};
 const end=c.length-1;
 for(let right=end-o.pivot;right>=Math.max(o.pivot+o.minCupBars,end-o.maxHandleBars-o.maxSignalAge-o.pivot);right--){
  if(!highPivot(c,right,o.pivot))continue;
  for(let left=right-o.minCupBars;left>=Math.max(o.pivot,right-o.maxCupBars);left--){
   if(!highPivot(c,left,o.pivot))continue;
   let bottom=left+1;for(let k=left+2;k<right;k++)if(c[k].l<c[bottom].l)bottom=k;
   const initial=shape(c.slice(0,right+o.pivot+1),left,bottom,right,-1,o);
   if(!initial.pass)continue;
   const p={...initial.pattern,id:'cup-'+c[left].t+'-'+c[right].t,stage:'CUP',checks:initial.checks,events:[]};
   const event=(type,i,reason)=>{p.reason=reason;p.events.push({type,time:c[i].end,reason});};
   const retire=(type,i,reason)=>{p.stage=type;event(type,i,reason);};
   event('CUP',right+o.pivot,'오른쪽 림 회복 · 핸들 형성 대기');
   let lowIndex=right+1;
   for(let i=right+o.pivot;i<=end;i++){
    const b=c[i];
    if(p.stage==='ENTRY'){
     if(b.l<=p.levels.stop){retire('INVALID',i,'타점 이후 핸들 지지 이탈');break;}
     if(b.c<p.rim-o.failureATR*p.entryAtr){retire('INVALID',i,'돌파 실패 · 림 아래 종가 복귀');break;}
     if(i-p.entryIndex>o.maxSignalAge){retire('EXPIRED',i,'타점 표시 기간 종료');break;}
     if(b.h>=p.levels.targets[2].price){retire('COMPLETE',i,'TP3 도달 · 타점 추적 종료');break;}
     continue;
    }
    // All post-rim bars, including the early forming handle, must retain support.
    lowIndex=right+1;for(let k=right+2;k<=i;k++)if(c[k].l<c[lowIndex].l)lowIndex=k;
    const low=c[lowIndex].l,rel=(p.rim-low)/p.cupDepth;
    if(low<=p.cupBottom||rel>o.maxHandleDepth){retire('FILTERED',i,'핸들 지지 이탈 또는 과도한 눌림');break;}
    if(i-right>o.maxHandleBars){retire('EXPIRED',i,'핸들 형성 기간 종료');break;}
    if(i-right<o.minHandleBars||rel<o.minHandleRetrace)continue;
    const prefix=c.slice(0,i+1),sh=shape(prefix,left,bottom,right,lowIndex,o);
    if(!sh.pass)continue;
    Object.assign(p,sh.pattern);p.stage='HANDLE';
    // Compare within the handle, not the wide body of the preceding rim candle.
    const confirmed=lowIndex<=i-o.pivot&&c.slice(lowIndex+1,lowIndex+o.pivot+1).every(x=>x.l>=low);
    const avg=mean(c.slice(Math.max(0,i-20),i).map(x=>x.v)),vol=avg>0?b.v/avg:0;
    const range=b.h-b.l,body=range?(b.c-b.o)/range:0,close=range?(b.c-b.l)/range:0,atr=atrAt(c,i);
    const checks=[check('handleConfirmed','핸들 저점 확인',confirmed,'저점 이후 '+o.pivot+'개 봉 확인'),
     check('handleStillValid','핸들 지지 유지',b.l>=low&&low>p.cupBottom+p.cupDepth*.5,'핸들 저점 '+low),
     check('breakout','새 림 종가 돌파',b.c>p.rim&&c[i-1].c<=p.rim,'종가 '+b.c+' / 림 '+p.rim),
     check('volume','돌파 거래량',vol>=o.minVolumeRatio,vol.toFixed(2)+'배 / 최소 '+o.minVolumeRatio+'배'),
     check('body','돌파 양봉 몸통',b.c>b.o&&body>=o.minBodyRatio,(body*100).toFixed(0)+'%'),
     check('close','봉 상단 종가',close>=o.minClosePosition,(close*100).toFixed(0)+'%'),
     check('extension','추격 방지',atr>0&&(b.c-p.rim)/atr<=o.maxExtensionATR,((b.c-p.rim)/(atr||1)).toFixed(2)+' ATR')];
    p.checks=[...sh.checks,...checks];p.reason='핸들 지지 · 새 림 돌파 확인 대기';
    if(checks.every(x=>x.pass)){
     p.stage='ENTRY';p.entry=b.c;p.entryIndex=i;p.entryTime=b.end;p.entryAtr=atr;p.levels=levels(b.c,low,p.cupDepth);
     event('ENTRY',i,'완성 봉 림 돌파 · 핸들 지지와 거래량 확인');
    }
   }
   if(['CUP','HANDLE','ENTRY'].includes(p.stage))candidates.push(p);else history.push(p);
  }
 }
 const rank={ENTRY:0,HANDLE:1,CUP:2},seen=new Set();
 const visible=candidates.sort((a,b)=>rank[a.stage]-rank[b.stage]||b.rightIndex-a.rightIndex).filter(p=>{if(seen.has(p.id))return false;seen.add(p.id);return true;}).slice(0,o.maxCandidates);
 return{active:visible[0]||null,candidates:visible,history};
}
function fromRaw(raw,now){return raw.filter(r=>Number(r[6])<now).map(r=>({t:+r[0],end:+r[6],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5]})).filter(x=>[x.t,x.end,x.o,x.h,x.l,x.c,x.v].every(Number.isFinite)&&x.h>=Math.max(x.o,x.c,x.l)&&x.l<=Math.min(x.o,x.c)&&x.l>0&&x.v>=0);}
function validate(c,interval){if(c.length<40)throw Error('완성 캔들 부족');for(let i=1;i<c.length;i++)if(c[i].t-c[i-1].t!==interval)throw Error('캔들 누락 또는 시간 중복');return c;}
export{defaults,atrAt,highPivot,lowPivot,shape,levels,detect,fromRaw,validate};
