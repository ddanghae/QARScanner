'use strict';
const defaults=Object.freeze({pivot:2,minDropATR:1.5,recovery:.65,minBounceATR:1,minPullbackATR:.6,supportBounceATR:.5,minSeparation:6,maxFormation:60,maxSignalAge:12,breakoutATR:.15,filters:true,allowContinuation:true,minHeightATR:1.5,necklineATR:.75,necklineHeightRatio:.2,minSecondDepthATR:1,maxClassicGapRatio:.25,maxRisingGapRatio:.25,maxLegRatio:3,minBreakoutVolume:1.3,minBodyRatio:.5,minClosePosition:.7,maxExtensionATR:1.5,failureATR:.15,maxCandidates:6,maxSeeds:12,retryBars:6,maxAttempts:3,maxResets:2,retestBars:6,retestATR:.15});
const mean=a=>a.reduce((s,x)=>s+x,0)/(a.length||1);
function atrAt(c,i){return mean(c.slice(Math.max(0,i-13),i+1).map((x,j)=>{const p=c[Math.max(0,i-13)+j-1];return p?Math.max(x.h-x.l,Math.abs(x.h-p.c),Math.abs(x.l-p.c)):x.h-x.l;}));}
function lowPivot(c,i,p){if(i<p||i+p>=c.length)return false;for(let j=i-p;j<=i+p;j++){if(j!==i&&(c[j].l<c[i].l||(j<i&&c[j].l===c[i].l)))return false;}return true;}
function emaAt(c,i,period=20){let e=c[0].c;for(let k=1;k<=i;k++)e+=(c[k].c-e)*2/(period+1);return e;}
function contextAt(c,p){
 const k=p.peakIndex,j=p.l1Index;
 if(k>=10&&c[k].c>emaAt(c,k)&&emaAt(c,k)-emaAt(c,k-5)>.25*p.atr)return 'CONTINUATION';
 const early=mean(c.slice(Math.max(0,j-20),Math.max(1,j-10)).map(x=>x.c));
 const late=mean(c.slice(Math.max(0,j-9),j+1).map(x=>x.c));
 return early-late>.5*p.atr?'REVERSAL':'BASE';
}
const check=(id,label,pass,value,required=true)=>({id,label,pass,value,required});
// User-defined W: the first and middle peaks share a resistance zone;
// the right leg must recover to that zone before the formation becomes TARGET.
function necklineBand(p,options={}){const o={...defaults,...options};return Math.min(p.atr*o.necklineATR,(p.neck-p.l1)*o.necklineHeightRatio);}
function shapeChecks(c,p,options={}){
 const o={...defaults,...options},height=p.neck-p.l1,depth=p.neck-p.l2;
 const gap=(p.l2-p.l1)/height,left=p.neckIndex-p.l1Index,right=p.l2Index-p.neckIndex;
 const context=contextAt(c,p);p.context=context;p.kind=context==='CONTINUATION'?'상승 중 W':context==='REVERSAL'?'반전형 W':'횡보형 W';
 const maxGap=context==='CONTINUATION'?o.maxRisingGapRatio:o.maxClassicGapRatio;
 const prominence=Math.max(p.atr,height*.5);
 let extra=0;for(let k=p.l1Index+o.pivot+1;k<=p.l2Index-o.pivot-1;k++){
  if(!lowPivot(c,k,o.pivot)||c[k].l>p.l1+height*.35)continue;
  const before=Math.max(...c.slice(p.l1Index+1,k).map(x=>x.h))-c[k].l;
  const after=Math.max(...c.slice(k+1,p.l2Index).map(x=>x.h))-c[k].l;
  if(before>=prominence&&after>=prominence)extra++;
 }
 const v1=mean(c.slice(p.peakIndex+1,p.l1Index+1).map(x=>x.v)),v2=mean(c.slice(p.neckIndex+1,p.l2Index+1).map(x=>x.v));
 const band=necklineBand(p,o),peak=c[p.peakIndex];
 const middleClose=Math.max(...c.slice(p.l1Index+1,p.l2Index).map(x=>x.c));
 return [
  check('necklineAlignment','시작·중간 고점의 넥라인 정렬',!!peak&&band>0&&Math.abs(peak.h-p.neck)<=band,`고점 차이 ${peak?Math.abs(peak.h-p.neck).toPrecision(4):'없음'} / 허용 ${band.toPrecision(4)}`),
  check('necklineBody','중간 반등의 종가 회복',middleClose>=p.neck-band,`중간 최고 종가 ${middleClose} / 넥라인 구역 ${p.neck-band} 이상`),
  check('context','상승 중 W 포함 설정',context!=='CONTINUATION'||o.allowContinuation,p.kind),
  check('height','충분한 중간 반등',height>=o.minHeightATR*p.atr,`${(height/p.atr).toFixed(2)} ATR / 최소 ${o.minHeightATR}`),
  check('depth','두 번째 눌림 깊이',depth>=o.minSecondDepthATR*p.atr,`${(depth/p.atr).toFixed(2)} ATR / 최소 ${o.minSecondDepthATR}`),
  check('bottoms','두 저점의 높이 차이',gap>=0&&gap<=maxGap,`${(gap*100).toFixed(1)}% / W 높이의 최대 ${maxGap*100}%`),
  check('spacing','두 저점 간격',p.l2Index-p.l1Index>=o.minSeparation,`${p.l2Index-p.l1Index}개 봉 / 최소 ${o.minSeparation}`),
  check('balance','구분되는 두 다리',left>=2&&right>=2&&Math.max(left,right)/Math.min(left,right)<=o.maxLegRatio,`${left} : ${right}개 봉 / 각 2개 이상, 비율 ≤ ${o.maxLegRatio}`),
  check('multiple','중간에 추가 저점 없음',extra===0,`${extra}개 추가 지지 저점`),
  check('pullbackVolume','눌림 거래량 과열 없음',v1>0&&v2<=v1*1.2,v1>0?`첫 하락 대비 ${(v2/v1).toFixed(2)}배 · 참고`:'거래량 확인 불가 · 참고',false)
 ];
}
function breakoutChecks(c,p,i,options={}){
 const o={...defaults,...options},b=c[i],range=b.h-b.l;
 const avgVol=mean(c.slice(Math.max(0,i-20),i).map(x=>x.v)),rvol=avgVol>0?b.v/avgVol:0;
 const body=range>0?(b.c-b.o)/range:0,close=range>0?(b.c-b.l)/range:0,extension=(b.c-p.neck)/p.atr;
 return [check('volume','돌파 거래량 증가',rvol>=o.minBreakoutVolume,`${rvol.toFixed(2)}배 / 최소 ${o.minBreakoutVolume}배`),
  check('body','돌파 양봉 몸통',b.c>b.o&&body>=o.minBodyRatio,`${(body*100).toFixed(0)}% / 최소 ${o.minBodyRatio*100}%`),
  check('close','윗꼬리보다 강한 종가',close>=o.minClosePosition,`봉 범위의 ${(close*100).toFixed(0)}% / 최소 ${o.minClosePosition*100}%`),
  check('extension','돌파 직후 과도한 상승 없음',extension<=o.maxExtensionATR,`${extension.toFixed(2)} ATR / 최대 ${o.maxExtensionATR}`)];
}
const failed=checks=>checks.filter(x=>x.required&&!x.pass);
// Reference levels only. Freeze at each confirmed entry; never use later prices.
function tradeLevels(p,entry=p.entry){
 const stop=p.l2,risk=entry-stop;
 if(![entry,stop,risk].every(Number.isFinite)||stop<=0||risk<=0)return null;
 const targets=[1,2,3].map(r=>({label:'TP'+r,r,price:entry+r*risk,percent:100*r*risk/entry}));
 if(targets.some(t=>!Number.isFinite(t.price)||t.price<=entry))return null;
 return {entry,stop,risk,riskPercent:100*risk/entry,targets};
}
// Profiles are deliberately separate, but not optimized against an evaluation period.
const profiles=Object.freeze({'15m':Object.freeze({...defaults}),'1h':Object.freeze({...defaults})});
function optionsFor(tf,overrides={}){return {...(profiles[tf]||defaults),...overrides};}
function peakBefore(c,j,o){
 // Use a confirmed swing high belonging to the first decline, not an arbitrary range maximum.
 for(let k=j-o.pivot;k>=Math.max(o.pivot,j-20);k--){
  const high=c[k].h;
  if(j-k<2||high-c[j].l<o.minDropATR*atrAt(c,j))continue;
  if(c.slice(k-o.pivot,k+o.pivot+1).every((b,n)=>n===o.pivot||b.h<=high))return k;
 }
 return -1;
}
function visibleCandidates(candidates){
 const rank={ENTRY:0,TARGET:1,RECOVERY:2,WATCH:3},seen=new Set();
 return candidates.slice().sort((a,b)=>rank[a.stage]-rank[b.stage]||b.events.at(-1).time-a.events.at(-1).time||a.l1Index-b.l1Index).filter(p=>{
  const key=p.l2Index===undefined?'first:'+p.l1Index:'second:'+p.l2Index;
  if(seen.has(key))return false;seen.add(key);return true;
 });
}
function structurePoints(c,p){
 const points=[];
 const add=(index,price)=>{if(Number.isInteger(index)&&index>=0&&index<c.length&&Number.isFinite(price))points.push([index,price]);};
 add(p.peakIndex,c[p.peakIndex]?.h);add(p.l1Index,p.l1);add(p.neckIndex,p.neck);
 if(p.l2Index!==undefined)add(p.l2Index,p.l2);
 if(p.bounceIndex!==undefined)add(p.bounceIndex,p.bounce);
 if(p.entryIndex!==undefined)add(p.entryIndex,p.entry);
 return points;
}
// Advance every candidate with only the prefix through i. Never backdate confirmations.
function detect(c,options={}){
 const o={...defaults,...options},history=[],seeds=[];let candidates=[];
 const event=(p,type,i,reason)=>p.events.push({type,time:c[i].end,price:c[i].c,reason});
 const retire=(p,type,i,reason)=>{p.stage=type;p.reason=reason;event(p,type,i,reason);history.push(p);};
 const reject=(p,i)=>retire(p,'FILTERED',i,failed(p.checks).map(x=>x.label+' 미충족').join(' · '));
 const enter=(p,i)=>{p.stage='ENTRY';p.entry=c[i].c;p.entryIndex=i;p.entryTime=c[i].end;p.levels=tradeLevels(p);event(p,'ENTRY',i,o.filters?'돌파 후 넥라인 위 종가 유지 확인':'넥라인 종가 돌파 · W 완성');};
 const retry=(p,i,checks)=>{
  p.attempts??=[];p.attempts.push({time:c[i].end,checks:checks.map(x=>({...x}))});
  p.pending=false;p.retryStart??=i;p.lastAttemptIndex=i;
  p.waitReason=failed(checks).map(x=>x.label+' 미충족').join(' · ');
  event(p,'RETRY',i,p.waitReason+' · 구조 유지 시 재돌파 대기');
  if(p.attempts.length>=o.maxAttempts)retire(p,'EXPIRED',i,'돌파 확인 재시도 횟수 종료');
 };
 function advance(p,i){
  const b=c[i];
  if(b.l<p.l1)return retire(p,'INVALID',i,'첫 저점 이탈');
  if(p.stage==='ENTRY'){
   if(b.l<p.l2)return retire(p,'INVALID',i,'타점 이후 두 번째 지지 저점 이탈');
   if(o.filters&&b.c<p.neck-o.failureATR*p.atr)return retire(p,'INVALID',i,'돌파 실패 · 넥라인 아래 종가 복귀');
   if(i-p.entryIndex>o.maxSignalAge)return retire(p,'EXPIRED',i,'타점 표시 기간 종료');
   if(!p.retestTime&&i>p.entryIndex&&i-p.entryIndex<=o.retestBars&&b.l<=p.neck+o.retestATR*p.atr&&b.l>=p.neck-o.retestATR*p.atr&&b.c>p.neck&&b.c>b.o&&(b.c-p.neck)/p.atr<=o.maxExtensionATR){
    p.retestTime=b.end;p.retestPrice=b.c;p.retestLevels=tradeLevels(p,b.c);event(p,'RETEST',i,'넥라인 구역 재접촉 후 양봉 종가 회복');
   }
   return;
  }
  if(i-p.l1Index>o.maxFormation)return retire(p,'EXPIRED',i,'W 형성 대기 기간 종료');
  if(p.retryStart!==undefined&&i-p.retryStart>o.retryBars)return retire(p,'EXPIRED',i,'돌파 재확인 대기 기간 종료');
  if(['TARGET','RECOVERY'].includes(p.stage)&&b.l<p.l2){
   if(!o.filters)return retire(p,'INVALID',i,'두 번째 지지 저점 이탈');
   if((p.resets||0)>=o.maxResets)return retire(p,'EXPIRED',i,'두 번째 바닥 재확인 횟수 종료');
   p.resets=(p.resets||0)+1;p.resetAfter=i;p.pending=false;p.stage='WATCH';p.pullback=true;p.support=null;p.checks=[];
   delete p.l2;delete p.l2Index;delete p.waitReason;delete p.earlyBreakout;delete p.rightPeak;delete p.rightPeakIndex;delete p.targetIndex;delete p.recoveryIndex;
   event(p,'SUPPORT',i,'첫 저점 유지 · 두 번째 바닥 재확인');
   return;
  }
  if(p.stage==='WATCH'){
   if(!p.pullback){
    if(b.h>p.neck){p.neck=b.h;p.neckIndex=i;}
    if(i>p.neckIndex&&p.neck-b.l>=o.minPullbackATR*p.atr)p.pullback=true;
   }
   if(p.pullback){
    const j=i-o.pivot;
    if(p.support&&b.l<c[p.support].l)p.support=null;
    if(j>=p.neckIndex+2&&j-p.l1Index>=o.minSeparation&&j>=(p.resetAfter??0)&&lowPivot(c,j,o.pivot)&&c[j].l>=p.l1&&p.neck-c[j].l>=o.minPullbackATR*p.atr){
     if(p.support==null||c[j].l<c[p.support].l)p.support=j;
    }
    // A confirmed trough remains eligible when its recovery takes longer than two bars.
    if(p.support!=null&&b.c-c[p.support].l>=o.supportBounceATR*p.atr){
     p.l2Index=p.support;p.l2=c[p.support].l;
     if(o.filters){
      let n=p.l1Index+1;for(let k=n;k<p.l2Index;k++)if(c[k].h>c[n].h)n=k;
      p.neck=c[n].h;p.neckIndex=n;p.checks=shapeChecks(c,p,o);
      if(failed(p.checks).length)return reject(p,i);
     }
    delete p.earlyBreakout;p.recoveryIndex=i;p.bounceIndex=i;p.bounce=b.c;p.stage=o.filters?'RECOVERY':'TARGET';
    if(o.filters)event(p,'RECOVERY',i,'두 번째 지지 확인 · 오른쪽 고점 넥라인 회복 대기');
    else{p.targetIndex=i;event(p,'TARGET',i,'첫 저점 위에서 두 번째 지지 확인');}
    }else if(b.c>p.neck+o.breakoutATR*p.atr){
     // Allow the right-hand pivot bars to finish before declaring a premature breakout.
     p.earlyBreakout??=i;
     if(i-p.earlyBreakout>=o.pivot)return retire(p,'EXPIRED',i,'두 번째 지지 확인 없이 상승');
    }else delete p.earlyBreakout;
   }
  }
  if(!['TARGET','RECOVERY'].includes(p.stage))return;
  // Retain the right-hand recovery leg so the chart shows the complete W after L2.
  if(p.bounce===undefined||b.h>p.bounce){p.bounce=b.h;p.bounceIndex=i;}
  if(o.filters&&!p.pending){
   const j=i-o.pivot;
   if(j>=p.l2Index+4&&lowPivot(c,j,o.pivot)&&c[j].l<=p.l1+(p.neck-p.l1)*.35&&Math.max(...c.slice(p.l2Index+1,j).map(x=>x.h))-c[j].l>=Math.max(p.atr,(p.neck-p.l1)*.5)&&b.c-c[j].l>=o.supportBounceATR*p.atr){p.checks.push(check('thirdLow','두 번째 지지 이후 추가 저점 없음',false,'세 번째 지지 저점 확인'));return reject(p,i);}
  }
  if(p.stage==='RECOVERY'){
   const band=necklineBand(p,o);
   const breakChecks=breakoutChecks(c,p,i,o),breaking=b.c>p.neck+o.breakoutATR*p.atr;
   if(breaking&&!breakChecks.find(x=>x.id==='extension').pass){p.checks.push(...breakChecks);return retire(p,'MISSED',i,'넥라인 회복 시점 상승 과다 · 타점 제외');}
   const near=b.h>=p.neck-band&&b.h<=p.neck+band&&b.c>=p.neck-band;
   p.checks=p.checks.filter(x=>x.id!=='rightNeckline');
   p.checks.push(check('rightNeckline','오른쪽 고점의 넥라인 회복',near||(breaking&&!failed(breakChecks).length),`고가 ${b.h} · 종가 ${b.c} / 구역 ${p.neck-band} ~ ${p.neck+band}`));
   if(!p.checks.at(-1).pass)return;
   p.rightPeakIndex=i;p.rightPeak=b.h;p.targetIndex=i;p.stage='TARGET';
   event(p,'TARGET',i,'세 고점 넥라인 정렬 · 오른쪽 종가 회복 확인');
  }
  if(o.filters&&p.pending&&i>p.breakoutIndex){
   const checks=[check('hold','돌파 다음 봉 종가 유지',b.c>p.neck,`다음 봉 종가 ${b.c} / 넥라인 ${p.neck}`),check('confirmExtension','확인 시점 과도한 상승 없음',(b.c-p.neck)/p.atr<=o.maxExtensionATR,`${((b.c-p.neck)/p.atr).toFixed(2)} ATR / 최대 ${o.maxExtensionATR}`)];
   if(!checks[1].pass){p.checks.push(...checks);return retire(p,'MISSED',i,'확인 시점 상승 과다 · 타점 제외');}
   if(failed(checks).length)return retry(p,i,checks);
   p.checks.push(...checks);enter(p,i);return;
  }
  if(!p.pending&&b.c>p.neck+o.breakoutATR*p.atr){
   // A retry needs a fresh crossing or a later strong bullish expansion, not a stale close.
   if(p.lastAttemptIndex!==undefined&&!(c[i-1].c<=p.neck+o.breakoutATR*p.atr||b.c>c[i-1].h))return;
   p.volumeRatio=b.v/(mean(c.slice(Math.max(0,i-20),i).map(x=>x.v))||1);
   if(!o.filters){enter(p,i);return;}
   const checks=breakoutChecks(c,p,i,o);
   if(!checks.find(x=>x.id==='extension').pass){p.checks.push(...checks);return retire(p,'MISSED',i,'돌파 시점 상승 과다 · 타점 제외');}
   if(failed(checks).length)return retry(p,i,checks);
   p.checks=p.checks.filter(x=>!['volume','body','close','extension','hold','confirmExtension'].includes(x.id));
   p.checks.push(...checks);p.pending=true;delete p.waitReason;
   p.breakoutIndex=i;p.breakoutTime=b.end;p.breakoutPrice=b.c;
   event(p,'BREAKOUT',i,'돌파 검증 통과 · 다음 봉 종가 유지 대기');
  }
 }
 for(let i=14+o.pivot;i<c.length;i++){
  for(const p of candidates)advance(p,i);
  candidates=candidates.filter(p=>['WATCH','RECOVERY','TARGET','ENTRY'].includes(p.stage));
  for(let k=seeds.length-1;k>=0;k--)if(c[i].l<c[seeds[k].j].l||i-seeds[k].j>o.maxFormation)seeds.splice(k,1);
  const j=i-o.pivot;
  if(lowPivot(c,j,o.pivot)){
   const atr=atrAt(c,j),peak=peakBefore(c,j,o);
   if(atr>0&&peak>=0){seeds.push({j,atr,peak,drop:c[peak].h-c[j].l});if(seeds.length>o.maxSeeds)seeds.shift();}
  }
  for(let k=seeds.length-1;k>=0;k--){
   const {j:bottom,atr,peak,drop}=seeds[k];
   if(c[i].c-c[bottom].l<Math.max(o.minBounceATR*atr,drop*o.recovery)||candidates.length>=o.maxCandidates)continue;
   let n=bottom+1;for(let t=bottom+1;t<=i;t++)if(c[t].h>c[n].h)n=t;
   const p={id:String(c[bottom].t),stage:'WATCH',atr,l1:c[bottom].l,l1Index:bottom,peakIndex:peak,neck:c[n].h,neckIndex:n,watchIndex:i,pullback:false,events:[],checks:[],filtered:o.filters};
   event(p,'WATCH',i,'첫 번째 V 회복 확인');candidates.push(p);seeds.splice(k,1);
  }
 }
 const visible=visibleCandidates(candidates);
 return {active:visible[0]||null,candidates:visible,history};
}
function fromRaw(raw,now){return raw.filter(r=>Number(r[6])<now).map(r=>({t:+r[0],end:+r[6],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5]})).filter(x=>[x.t,x.end,x.o,x.h,x.l,x.c,x.v].every(Number.isFinite)&&x.h>=Math.max(x.o,x.c,x.l)&&x.l<=Math.min(x.o,x.c)&&x.l>0&&x.v>=0);}
function validate(c,interval){if(c.length<40)throw Error('완성 캔들 부족');for(let i=1;i<c.length;i++)if(c[i].t-c[i-1].t!==interval)throw Error('캔들 누락 또는 시간 중복');return c;}
export { tradeLevels, profiles, optionsFor, visibleCandidates, structurePoints, detect, fromRaw, validate, defaults, atrAt, shapeChecks, breakoutChecks, contextAt, necklineBand };
