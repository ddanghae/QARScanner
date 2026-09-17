import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseKlines } from '../../js/api/binance.js';

export const STEP = 300000, DAY = 86400000;
export const digest = value => createHash('sha256').update(value).digest('hex');
export async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
export async function writeJson(path, data) { await writeFile(path, JSON.stringify(data, null, 2)); }

export function validateConfig(c) {
  const start = Date.parse(c.start), end = Date.parse(c.end);
  if (!Array.isArray(c.symbols) || !c.symbols.length || c.symbols.some(s => !/^[A-Z0-9]{2,24}USDT$/.test(s))
      || new Set(c.symbols).size !== c.symbols.length) throw Error('symbols: 중복 없는 USDT 심볼 목록이 필요합니다.');
  if (![start, end].every(Number.isFinite) || start >= end || start % DAY || end % DAY)
    throw Error('start/end는 UTC 자정이며 start < end여야 합니다. end는 미포함입니다.');
  if (end > Date.now()) throw Error('아직 끝나지 않은 날짜를 데이터 종료일로 사용할 수 없습니다.');
  if (!(c.warmupDays >= 40) || c.warmupDays * DAY >= end - start) throw Error('40일 이상 준비 구간과 그 이후 시험 구간이 필요합니다.');
  if (!Number.isInteger(c.evaluationMinutes) || c.evaluationMinutes < 5 || c.evaluationMinutes % 5)
    throw Error('evaluationMinutes는 5분의 양의 배수입니다.');
  if (!(c.holdHours > 0) || !Number.isInteger(c.holdHours * 12)) throw Error('holdHours는 5분의 양의 배수입니다.');
  if (![c.feeBpsPerSide, c.slippageBpsPerSide].every(v => Number.isFinite(v) && v >= 0)) throw Error('비용은 0 이상 숫자입니다.');
  if (!(c.reversalMinScore >= 0 && c.reversalMinScore <= 100) || !Number.isInteger(c.minResolvedTrades) || c.minResolvedTrades < 1) throw Error('점수/최소 표본 설정 오류');
  if (!Array.isArray(c.splitFractions) || c.splitFractions.length !== 3
      || c.splitFractions.some(v => !Number.isFinite(v) || v <= 0)
      || Math.abs(c.splitFractions.reduce((a,b) => a+b, 0) - 1) > 1e-9) throw Error('분할 비중 합계는 1이어야 합니다.');
  return c;
}

export function quality(rows, start, end) {
  let duplicates = 0, invalid = 0, gaps = 0, unordered = 0;
  const seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    if (seen.has(c.openTime)) duplicates++;
    seen.add(c.openTime);
    if (![c.openTime,c.closeTime,c.open,c.high,c.low,c.close,c.volume,c.quoteVolume,c.trades,c.takerBuyBase,c.takerBuyQuote].every(Number.isFinite)
      || c.openTime % STEP || c.closeTime !== c.openTime + STEP - 1
      || c.low <= 0 || c.high < Math.max(c.open,c.close) || c.low > Math.min(c.open,c.close)
      || c.volume < 0 || c.quoteVolume < 0 || c.trades < 0 || c.takerBuyBase < 0 || c.takerBuyBase > c.volume
      || c.takerBuyQuote < 0 || c.takerBuyQuote > c.quoteVolume || c.openTime < start || c.closeTime >= end) invalid++;
    if (i) {
      const delta = c.openTime - rows[i-1].openTime;
      if (delta <= 0) unordered++;
      if (delta > STEP) gaps += Math.floor(delta/STEP)-1;
    }
  }
  const expected = (end-start)/STEP;
  const missing = Math.max(0, expected-seen.size);
  return { rows:rows.length, expected, missing, coverage:expected ? seen.size/expected : 0,
    duplicates, invalid, gaps, unordered, first:rows[0]?.openTime ?? null, last:rows.at(-1)?.closeTime ?? null,
    ok: rows.length > 0 && missing===0 && !duplicates && !invalid && !gaps && !unordered };
}

export function aggregate(rows, interval) {
  if (!Number.isInteger(interval/STEP) || interval < STEP) throw Error('집계 주기 오류');
  const buckets = new Map();
  for (const c of rows) {
    const t = Math.floor(c.openTime/interval)*interval;
    if (!buckets.has(t)) buckets.set(t, []);
    buckets.get(t).push(c);
  }
  const result = [];
  for (const [t, bars] of buckets) {
    if (bars.length !== interval/STEP || bars.some((b,i) => b.openTime !== t+i*STEP)) continue;
    const sum = key => bars.reduce((a,b) => a+b[key],0);
    result.push({ openTime:t,closeTime:t+interval-1,open:bars[0].open,close:bars.at(-1).close,
      high:Math.max(...bars.map(b=>b.high)),low:Math.min(...bars.map(b=>b.low)),
      volume:sum('volume'),quoteVolume:sum('quoteVolume'),trades:sum('trades'),
      takerBuyBase:sum('takerBuyBase'),takerBuyQuote:sum('takerBuyQuote'),takerSellBase:sum('takerSellBase') });
  }
  return result;
}

export async function api(path) {
  for (let i=0;i<4;i++) {
    const res = await fetch('https://fapi.binance.com'+path,{signal:AbortSignal.timeout(20000)});
    if (res.ok) return res.json();
    if (![429,418,500,502,503,504].includes(res.status)) throw Error(`Binance HTTP ${res.status}`);
    const retry = Number(res.headers.get('retry-after'));
    const delay = Number.isFinite(retry) && retry > 0 ? retry*1000 : (i+1)*2000;
    if (delay > 30000 || res.status===418) throw Error('거래소 호출 제한. 나중에 재실행하세요.');
    await new Promise(r=>setTimeout(r,delay));
  }
  throw Error('Binance 재시도 소진');
}

export async function fetchRange(symbol,start,end) {
  if(!/^[A-Z0-9]{2,24}USDT$/.test(symbol)) throw Error('잘못된 심볼');
  const rows=[];
  for(let cursor=start;cursor<end;) {
    const raw=await api(`/fapi/v1/klines?symbol=${symbol}&interval=5m&startTime=${cursor}&endTime=${end-1}&limit=1000`);
    if(!raw.length) break;
    const page=parseKlines(raw).filter(c=>c.openTime>=start && c.closeTime<end);
    if(!page.length || page.at(-1).openTime<cursor) throw Error('페이지 진행 실패');
    rows.push(...page);cursor=page.at(-1).closeTime+1;
    await new Promise(r=>setTimeout(r,150));
  }
  return rows;
}

export async function collect(config, root) {
  validateConfig(config); await mkdir(root,{recursive:true});
  const start=Date.parse(config.start), end=Date.parse(config.end);
  const key=digest(JSON.stringify({symbols:config.symbols,start,end})).slice(0,16);
  const dir=join(root,key); await mkdir(dir,{recursive:true});
  const info=await api('/fapi/v1/exchangeInfo');
  const manifest={schema:1,id:key,source:'Binance USDT-M public REST',start,end,collectedAt:new Date().toISOString(),
    universePolicy:'사용자가 고른 현재 종목. 상장폐지 종목을 포함한 과거 전체 시장 재현 아님.',symbols:[]};
  for(const symbol of config.symbols) {
    const meta=info.symbols.find(s=>s.symbol===symbol && s.contractType==='PERPETUAL');
    if(!meta) throw Error(`${symbol}: 현재 무기한 종목 메타데이터 없음`);
    const file=`${symbol}.5m.json.gz`, path=join(dir,file);
    let rows;
    try { rows=JSON.parse(gunzipSync(await readFile(path))); } catch(e) { if(e.code!=='ENOENT') throw e; }
    if(!rows) {
      rows=[]; let cursor=start;
      while(cursor<end) {
        const raw=await api(`/fapi/v1/klines?symbol=${symbol}&interval=5m&startTime=${cursor}&endTime=${end-1}&limit=1000`);
        if(!raw.length) break;
        const parsed=parseKlines(raw).filter(c=>c.openTime>=start && c.closeTime<end);
        if(!parsed.length || parsed.at(-1).openTime<cursor) throw Error('페이지 진행 실패');
        rows.push(...parsed); cursor=parsed.at(-1).closeTime+1;
        await new Promise(r=>setTimeout(r,150));
      }
      const q=quality(rows,start,end);
      if(!q.ok) throw Error(`${symbol}: 데이터 품질 실패 ${JSON.stringify(q)}. 날짜 범위를 상장 이후로 조정하세요.`);
      await writeFile(path+'.tmp',gzipSync(JSON.stringify(rows)));
      await rename(path+'.tmp',path);
    }
    const q=quality(rows,start,end);
    if(!q.ok) throw Error(`${symbol}: 캐시 품질 실패 ${JSON.stringify(q)}`);
    manifest.symbols.push({symbol,file,onboardDate:meta.onboardDate,statusAtCollection:meta.status,
      sha256:digest(await readFile(path)),quality:q});
    console.log(`${symbol}: ${rows.length}개 5분봉 · 누락 ${q.missing}`);
  }
  await writeJson(join(dir,'manifest.json'),manifest);
  await writeJson(join(root,'latest.json'),{id:key});
  return {dir,manifest};
}

export async function loadDataset(root, id) {
  if(!id) id=(await readJson(join(root,'latest.json'))).id;
  if(!/^[a-f0-9]{16}$/.test(id)) throw Error('잘못된 데이터셋 ID');
  const dir=join(root,id), manifest=await readJson(join(dir,'manifest.json'));
  const series=new Map();
  for(const s of manifest.symbols) {
    if(!/^[A-Z0-9]+USDT\.5m\.json\.gz$/.test(s.file)) throw Error('잘못된 데이터 파일 이름');
    const bytes=await readFile(join(dir,s.file));
    if(digest(bytes)!==s.sha256) throw Error(`${s.symbol}: 체크섬 불일치`);
    const m5=JSON.parse(gunzipSync(bytes));
    if(!quality(m5,manifest.start,manifest.end).ok) throw Error(`${s.symbol}: 데이터 품질 실패`);
    series.set(s.symbol,{meta:s,k5m:m5,k15m:aggregate(m5,3*STEP),k1h:aggregate(m5,12*STEP),k4h:aggregate(m5,48*STEP)});
  }
  return {dir,manifest,series};
}
