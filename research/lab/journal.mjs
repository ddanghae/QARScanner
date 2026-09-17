import { mkdir,writeFile,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getKlines,closedOnly } from '../../js/api/binance.js';
import { forecastDirection } from '../../js/core/direction-forecast.js';
import { CONFIG } from '../../js/config.js';
import { candidates } from './strategies.mjs';
import { api,fetchRange,readJson,STEP,quality,digest } from './data.mjs';
import { simulate } from './engine.mjs';

export async function snapshot(config,root,provenance) {
  await mkdir(join(root,'snapshots'),{recursive:true});
  const metadata=await api('/fapi/v1/exchangeInfo');
  const btc=await getKlines('BTCUSDT','4h');
  const records=[];
  for(const symbol of config.symbols) {
    const meta=metadata.symbols.find(s=>s.symbol===symbol);
    if(!meta) throw Error(`${symbol}: 메타데이터 없음`);
    const raw=await Promise.all(['4h','1h','15m','5m'].map(tf=>getKlines(symbol,tf)));
    const observedAt=Date.now(), now=observedAt;
    const w=Object.fromEntries(['4h','1h','15m','5m'].map((tf,i)=>['k'+tf,closedOnly(raw[i],false,now)]));
    if(!w.k5m.length || now-w.k5m.at(-1).closeTime>STEP) throw Error(`${symbol}: 최신 5분 자료 없음`);
    const signals=candidates(symbol,meta,w,now,config).map(s=>({...s,
      setupTime:w.k5m.at(-1).closeTime,signalTime:Math.ceil(observedAt/STEP)*STEP-1}));
    records.push({symbol,observedAt,signals,forecast:forecastDirection(w.k4h,closedOnly(btc,false,now),{now}),
      source:'실시간 공개 API의 시간봉별 조회',inputHash:digest(JSON.stringify(w)),inputs:w});
  }
  const record={schema:1,id:randomUUID(),recordedAt:Date.now(),config,scannerConfig:CONFIG,provenance,records,
    execution:'관측 이후 최초 5분봉 시가로 모의 진입. 실제 주문 없음.',
    forecastNote:'방향 확률은 당시 값 보존용. 이 명령은 확률의 24h 정확도를 채점하지 않고 거래계획 결과만 채점합니다.'};
  const path=join(root,'snapshots',record.id+'.json');
  await writeFile(path,JSON.stringify(record,null,2),{flag:'wx'});
  return {path,signals:records.reduce((a,r)=>a+r.signals.length,0)};
}

export async function settle(root) {
  await mkdir(join(root,'snapshots'),{recursive:true});
  await mkdir(join(root,'outcomes'),{recursive:true});
  let done=0,pending=0,existing=0;
  const files=await readdir(join(root,'snapshots'));
  for(const file of files.filter(f=>/^[a-f0-9-]+\.json$/.test(f))) {
    const snap=await readJson(join(root,'snapshots',file));
    for(const record of snap.records) for(const signal of record.signals) {
      const id=`${snap.id}-${record.symbol}-${signal.strategy}`,path=join(root,'outcomes',id+'.json');
      try {await readJson(path);existing++;continue;} catch(e) {if(e.code!=='ENOENT') throw e;}
      const start=signal.signalTime+1,end=start+snap.config.holdHours*3600000;
      if(Date.now()<end) {pending++;continue;}
      const rows=await fetchRange(record.symbol,start,end);
      const q=quality(rows,start,end);
      if(!q.ok) {pending++;console.warn(`${record.symbol}: 결말 데이터 부족, 나중에 재시도`);continue;}
      const outcome=simulate(signal,rows,snap.config);
      await writeFile(path,JSON.stringify({snapshotId:snap.id,signal,settledAt:Date.now(),outcome,
        outcomeDataHash:digest(JSON.stringify(rows)),quality:q,executionCandles:rows},null,2),{flag:'wx'});
      done++;
    }
  }
  return {done,pending,existing};
}
