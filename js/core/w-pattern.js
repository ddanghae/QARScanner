'use strict';
const defaults=Object.freeze({pivot:2,minDropATR:1.5,recovery:.65,minBounceATR:1,minPullbackATR:.6,supportBounceATR:.5,minSeparation:6,maxFormation:60,maxSignalAge:12,breakoutATR:.15,filters:true,allowContinuation:true,minHeightATR:1.5,minSecondDepthATR:1,maxClassicGapRatio:.25,maxRisingGapRatio:.6,maxLegRatio:3,minBreakoutVolume:1.3,minBodyRatio:.5,minClosePosition:.7,maxExtensionATR:1.5,failureATR:.15});
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
 return [
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
// Each iteration knows only candles through i. Events keep their actual confirmation time.
function detect(c,options={}){
 const o={...defaults,...options};let a=null,seed=null;const history=[];
 const event=(p,type,i,reason)=>p.events.push({type,time:c[i].end,price:c[i].c,reason});
 const retire=(type,i,reason)=>{a.stage=type;a.reason=reason;event(a,type,i,reason);history.push(a);a=null;};
 const reject=(i)=>retire('FILTERED',i,failed(a.checks).map(x=>x.label+' 미충족').join(' · '));
 const enter=(i)=>{a.stage='ENTRY';a.entry=c[i].c;a.entryIndex=i;a.entryTime=c[i].end;event(a,'ENTRY',i,o.filters?'돌파 다음 봉의 넥라인 지지 확인':'넥라인 종가 돌파 · W 완성');};
 for(let i=14+o.pivot;i<c.length;i++){
  const b=c[i];
  if(a){
   // A wick below L1 disqualifies this exact pattern, regardless of a subsequent recovery.
   if(b.l<a.l1){retire('INVALID',i,'첫 저점 이탈');}
   else if(a.stage==='ENTRY'){
    if(b.l<a.l2)retire('INVALID',i,'타점 이후 두 번째 지지 저점 이탈');
    else if(o.filters&&b.c<a.neck-o.failureATR*a.atr)retire('INVALID',i,'돌파 실패 · 넥라인 아래 종가 복귀');
    else if(i-a.entryIndex>o.maxSignalAge)retire('EXPIRED',i,'타점 표시 기간 종료');
   }else if(i-a.l1Index>o.maxFormation){retire('EXPIRED',i,'W 형성 대기 기간 종료');}
   else if(a.stage==='WATCH'){
    if(!a.pullback){
     if(b.h>a.neck){a.neck=b.h;a.neckIndex=i;}
     if(i>a.neckIndex&&a.neck-b.l>=o.minPullbackATR*a.atr)a.pullback=true;
    }
    if(a.pullback){
     const j=i-o.pivot;
     if(j>=a.neckIndex+2&&j-a.l1Index>=o.minSeparation&&lowPivot(c,j,o.pivot)&&c[j].l>=a.l1&&a.neck-c[j].l>=o.minPullbackATR*a.atr&&b.c-c[j].l>=o.supportBounceATR*a.atr){
      a.l2=c[j].l;a.l2Index=j;
      if(o.filters){
       // The neckline must be the actual maximum between the two confirmed troughs.
       let n=a.l1Index+1;for(let k=n;k<j;k++)if(c[k].h>c[n].h)n=k;
       a.neck=c[n].h;a.neckIndex=n;a.checks=shapeChecks(c,a,o);
       if(failed(a.checks).length)reject(i);
      }
      if(a){a.targetIndex=i;a.stage='TARGET';event(a,'TARGET',i,'첫 저점 위에서 두 번째 지지 확인');}
     }else if(b.c>a.neck+o.breakoutATR*a.atr){retire('EXPIRED',i,'두 번째 지지 확인 없이 상승');}
    }
   }else if(a.stage==='TARGET'&&b.l<a.l2){retire('INVALID',i,'두 번째 지지 저점 이탈');}
   if(a&&o.filters&&a.stage==='TARGET'&&!a.pending){
    const j=i-o.pivot;
    if(j>=a.l2Index+4&&lowPivot(c,j,o.pivot)&&c[j].l<=a.l1+(a.neck-a.l1)*.35&&Math.max(...c.slice(a.l2Index+1,j).map(x=>x.h))-c[j].l>=Math.max(a.atr,(a.neck-a.l1)*.5)&&b.c-c[j].l>=o.supportBounceATR*a.atr){a.checks.push(check('thirdLow','두 번째 지지 이후 추가 저점 없음',false,'세 번째 지지 저점 확인'));reject(i);}
   }
   if(a&&a.stage==='TARGET'){
    if(o.filters&&a.pending&&i>a.breakoutIndex){
     a.checks.push(check('hold','돌파 다음 봉 지지',b.c>a.neck,`다음 봉 종가 ${b.c} / 넥라인 ${a.neck}`),check('confirmExtension','확인 시점 과도한 상승 없음',(b.c-a.neck)/a.atr<=o.maxExtensionATR,`${((b.c-a.neck)/a.atr).toFixed(2)} ATR / 최대 ${o.maxExtensionATR}`));
     if(failed(a.checks).length)reject(i);else enter(i);
    }else if(!a.pending&&b.c>a.neck+o.breakoutATR*a.atr){
     a.volumeRatio=b.v/(mean(c.slice(Math.max(0,i-20),i).map(x=>x.v))||1);
     if(o.filters){
      a.checks.push(...breakoutChecks(c,a,i,o));
      if(failed(a.checks).length)reject(i);
      else{a.pending=true;a.breakoutIndex=i;a.breakoutTime=b.end;a.breakoutPrice=b.c;event(a,'BREAKOUT',i,'돌파 검증 통과 · 다음 봉 지지 대기');}
     }else enter(i);
    }
   }
  }
  if(!a){
   const j=i-o.pivot;
   if(seed&&(b.l<c[seed.j].l||i-seed.j>o.maxFormation))seed=null;
   if(lowPivot(c,j,o.pivot)&&(!seed||c[j].l<c[seed.j].l)){
    const atr=atrAt(c,j);let peak=j-1;for(let k=Math.max(0,j-20);k<j;k++)if(c[k].h>c[peak].h)peak=k;
    const drop=c[peak].h-c[j].l;
    if(atr>0&&drop>=o.minDropATR*atr)seed={j,atr,peak,drop};
   }
   if(!seed)continue;
   const {j:bottom,atr,peak,drop}=seed;
   // Recovered first V, measured from the preceding local range high.
   if(b.c-c[bottom].l<Math.max(o.minBounceATR*atr,drop*o.recovery))continue;
   if(c.slice(bottom+1,i+1).some(x=>x.l<c[bottom].l))continue;
   let n=bottom+1;for(let k=bottom+1;k<=i;k++)if(c[k].h>c[n].h)n=k;
   a={id:String(c[bottom].t),stage:'WATCH',atr,l1:c[bottom].l,l1Index:bottom,peakIndex:peak,neck:c[n].h,neckIndex:n,watchIndex:i,pullback:false,events:[],checks:[],filtered:o.filters};seed=null;
   event(a,'WATCH',i,'첫 번째 V 회복 확인');
  }
 }
 return {active:a,history};
}
function fromRaw(raw,now){return raw.filter(r=>Number(r[6])<now).map(r=>({t:+r[0],end:+r[6],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5]})).filter(x=>[x.t,x.end,x.o,x.h,x.l,x.c,x.v].every(Number.isFinite)&&x.h>=Math.max(x.o,x.c,x.l)&&x.l<=Math.min(x.o,x.c)&&x.l>0);}
function validate(c,interval){if(c.length<40)throw Error('완성 캔들 부족');for(let i=1;i<c.length;i++)if(c[i].t-c[i-1].t!==interval)throw Error('캔들 누락 또는 시간 중복');return c;}
export { detect, fromRaw, validate, defaults, atrAt, shapeChecks, breakoutChecks, contextAt };
