import { CONFIG } from '../../js/config.js';
import { analyzeCandles } from '../../js/scanner/deep-scanner.js';
import { stage3Evaluate } from '../../js/scanner/prefilter.js';
import { buildEarlyResult } from '../../js/core/early-detect.js';
import { buildPumpFadeResult } from '../../js/core/pump-fade.js';
import { evaluateCrtTbs } from '../../js/core/crt-tbs.js';

export const STRATEGIES=['reversal','reversal_crt','early','early_crt','pump_fade','pump_fade_crt','crt_only'];
export function prefix(bars, now, limit=Infinity) {
  let lo=0,hi=bars.length;
  while(lo<hi) { const m=(lo+hi)>>1; if(bars[m].closeTime<now) lo=m+1; else hi=m; }
  return bars.slice(Math.max(0,lo-limit),lo);
}
export function windows(series,now) {
  return Object.fromEntries(['5m','15m','1h','4h'].map(tf=>['k'+tf,prefix(series['k'+tf],now,CONFIG.klinesLimit[tf])]));
}

export function candidates(symbol,meta,w,now,config) {
  const {k4h,k1h,k15m,k5m}=w;
  if(k4h.length<220 || k1h.length<25) return [];
  const bars=k1h.slice(-24), price=k5m.at(-1)?.close;
  const onboard=meta.onboardDate;
  const item={symbol,baseAsset:symbol.replace(/USDT$/,''),onboardDate:onboard,
    quoteVolume:bars.reduce((a,b)=>a+b.quoteVolume,0),count:bars.reduce((a,b)=>a+b.trades,0),
    change24h:100*(k1h.at(-1).close/k1h.at(-25).close-1),
    newListing:onboard ? now-onboard<CONFIG.prefilter.newListingDays*86400000 : false};
  const crt=evaluateCrtTbs(k4h,k5m,{now});
  const base=[];
  const liquid=price>=CONFIG.prefilter.minPrice && item.count>=CONFIG.prefilter.minTradeCount;
  if(liquid && item.quoteVolume>=CONFIG.prefilter.minQuoteVolume) {
    const pre=stage3Evaluate(item,k1h,'both');
    if(pre.pass) {
      const r=analyzeCandles({...item,pre},{direction:'both',includeRealtimeCandle:false},w,[],now);
      if(!r.skipped && r.score>=config.reversalMinScore && !r.noise?.noisy) base.push(r);
    }
    const pump=buildPumpFadeResult(item,k1h,k15m,k5m,CONFIG);
    if(pump?.score>=CONFIG.pumpFade.minScore && pump.plan.valid) base.push(pump);
  }
  if(liquid && item.quoteVolume>=CONFIG.earlyDetect.minQuoteVolume && !CONFIG.earlyDetect.excludeMajors.includes(item.baseAsset)) {
    const early=buildEarlyResult(item,k4h,[],null,CONFIG,now);
    if(early?.score>=CONFIG.earlyMinScore) base.push(early);
  }
  const out=[];
  for(const r of base) {
    const c={strategy:r.scanMode,symbol,direction:r.direction,score:r.score,stage:r.stage,
      signalTime:now-1,plan:r.plan,crtStatus:crt.status};
    out.push(c);
    // Paired comparison keeps the original exit plan; only the CRT entry gate changes.
    if(crt.confirmed && crt.direction===r.direction) out.push({...c,strategy:r.scanMode+'_crt'});
  }
  if(liquid && item.quoteVolume>=CONFIG.prefilter.minQuoteVolume && crt.confirmed) out.push({
    strategy:'crt_only',symbol,direction:crt.direction,signalTime:now-1,score:null,crtStatus:crt.status,
    plan:{...crt.plan,partialFrac:0.5},crtRange:crt.range});
  return out;
}
