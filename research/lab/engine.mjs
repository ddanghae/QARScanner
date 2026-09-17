import { STEP,DAY } from './data.mjs';
import { candidates,windows,STRATEGIES } from './strategies.mjs';

export function simulate(signal,bars,config) {
  const end=signal.signalTime+config.holdHours*3600000;
  const s=signal.direction==='long'?1:-1;
  const p=signal.plan, entry=bars[0]?.open, stop=p.invalidation ?? p.stop, tp1=p.tp1, tp2=p.tp2;
  const frac=p.partialFrac ?? 0.5;
  const base={status:'INVALID_PLAN',exitTime:signal.signalTime,r:null,netPct:null};
  if(!['long','short'].includes(signal.direction) || ![entry,stop,tp2,frac].every(Number.isFinite)
    || entry<=0 || stop<=0 || tp2<=0 || s*(entry-stop)<=0 || s*(tp2-entry)<=0 || frac<0 || frac>=1
    || (frac>0 && (!Number.isFinite(tp1) || s*(tp1-entry)<=0 || s*(tp2-tp1)<=0))) return base;
  if(bars[0].openTime!==signal.signalTime+1) return {...base,status:'INCOMPLETE'};
  const riskPct=Math.abs(entry-stop)/entry*100, costPct=2*(config.feeBpsPerSide+config.slippageBpsPerSide)/100;
  let taken=false,gross=0,currentStop=stop,previous=signal.signalTime;
  const pct=px=>s*(px-entry)/entry*100;
  const finish=(status,c,px)=>{
    const grossPct=gross+(taken?1-frac:1)*pct(px),netPct=grossPct-costPct;
    return {status,entry,initialStop:stop,tp1,tp2,exitPrice:px,exitTime:c.closeTime,
      grossPct,costPct,netPct,r:netPct/riskPct,partialTaken:taken};
  };
  for(const c of bars) {
    if(c.closeTime>end) break;
    if(![c.open,c.high,c.low,c.close].every(Number.isFinite) || c.low<=0
      || c.high<Math.max(c.open,c.close) || c.low>Math.min(c.open,c.close)) return {...base,status:'INCOMPLETE',exitTime:end};
    if(c.openTime!==previous+1 || c.closeTime!==c.openTime+STEP-1) return {...base,status:'INCOMPLETE',exitTime:end};
    previous=c.closeTime;
    // Gap stop: adverse open is executable; never assume a fill at the skipped stop.
    if(s*(c.open-currentStop)<=0) return finish(taken?'BREAKEVEN':'STOP',c,c.open);
    if(!taken && frac>0 && s*(c.open-tp1)>=0) { taken=true;gross=frac*pct(tp1);currentStop=entry; }
    if(s*(c.open-tp2)>=0) return finish('TARGET',c,tp2);
    const hitStop=s===1?c.low<=currentStop:c.high>=currentStop;
    const hitFirst=!taken && frac>0 && (s===1?c.high>=tp1:c.low<=tp1);
    const hitTarget=s===1?c.high>=tp2:c.low<=tp2;
    if(hitStop && (hitFirst||hitTarget)) return {...base,status:'AMBIGUOUS',exitTime:c.closeTime};
    if(hitStop) return finish(taken?'BREAKEVEN':'STOP',c,currentStop);
    if(hitFirst) {
      // After TP1 the stop moves to entry. OHLC cannot reveal intrabar order.
      if(s===1?c.low<=entry:c.high>=entry) return {...base,status:'AMBIGUOUS',exitTime:c.closeTime};
      taken=true;gross=frac*pct(tp1);currentStop=entry;
    }
    if(hitTarget) return finish('TARGET',c,tp2);
    if(c.closeTime===end) return finish('TIME',c,c.close);
  }
  return {...base,status:'INCOMPLETE',exitTime:end};
}

export function splits(config,manifest) {
  const start=manifest.start+config.warmupDays*DAY,end=manifest.end;
  const n=Math.floor((end-start)/STEP),f=config.splitFractions;
  const a=start+Math.floor(n*f[0])*STEP,b=start+Math.floor(n*(f[0]+f[1]))*STEP;
  return [{name:'train',start,end:a},{name:'validation',start:a,end:b},{name:'test',start:b,end}];
}

export function summarize(trades,minN) {
  const resolved=trades.filter(t=>Number.isFinite(t.r)),wins=resolved.filter(t=>t.netPct>0);
  const gains=resolved.reduce((a,t)=>a+Math.max(0,t.r),0),losses=-resolved.reduce((a,t)=>a+Math.min(0,t.r),0);
  let equity=0,peak=0,drawdown=0;
  for(const t of [...resolved].sort((a,b)=>a.exitTime-b.exitTime || a.symbol.localeCompare(b.symbol))) {
    equity+=t.r;peak=Math.max(peak,equity);drawdown=Math.max(drawdown,peak-equity);
  }
  return {signals:trades.length,resolved:resolved.length,ambiguous:trades.filter(t=>t.status==='AMBIGUOUS').length,
    incomplete:trades.filter(t=>t.status==='INCOMPLETE').length,invalid:trades.filter(t=>t.status==='INVALID_PLAN').length,
    winRate:resolved.length?wins.length/resolved.length:null,
    meanR:resolved.length?equity/resolved.length:null,profitFactor:losses>0?gains/losses:null,
    tradeOrderDrawdownR:drawdown,qualified:resolved.length>=minN,
    coverage:trades.length?resolved.length/trades.length:0};
}

export function backtest(dataset,config,onProgress=()=>{}) {
  const partition=splits(config,dataset.manifest),trades=[],counts={evaluations:0,purged:0};
  for(const [symbol,series] of dataset.series) {
    onProgress(symbol);
    const busy=new Map();
    for(let i=0;i<series.k5m.length;i++) {
      const now=series.k5m[i].closeTime+1;
      if(now%(config.evaluationMinutes*60000)) continue;
      const split=partition.find(s=>now>=s.start && now<s.end);
      if(!split) continue;
      // Fixed horizon embargo: no outcome from another partition is consumed.
      if(now+config.holdHours*3600000>split.end) {counts.purged++;continue;}
      const signals=candidates(symbol,series.meta,windows(series,now),now,config);
      counts.evaluations++;
      for(const signal of signals) {
        if((busy.get(signal.strategy)??-Infinity)>=now) continue;
        const future=series.k5m.slice(i+1,i+1+config.holdHours*12);
        const outcome=simulate(signal,future,config);
        trades.push({...signal,...outcome,split:split.name});
        // Unknown intrabar paths remain locked until horizon, avoiding optimistic re-entry.
        const unknown=['AMBIGUOUS','INCOMPLETE'].includes(outcome.status);
        busy.set(signal.strategy,unknown?now+config.holdHours*3600000:outcome.exitTime);
      }
    }
  }
  const comparison=partition.flatMap(split=>STRATEGIES.map(strategy=>({split:split.name,strategy,
    ...summarize(trades.filter(t=>t.split===split.name && t.strategy===strategy),config.minResolvedTrades)})));
  return {partition,counts,trades,comparison};
}
