#!/usr/bin/env node
import { readFile,readdir,mkdir } from 'node:fs/promises';
import { join,resolve,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { collect,loadDataset,readJson,writeJson,validateConfig,digest } from './data.mjs';
import { backtest } from './engine.mjs';
import { writeReport } from './report.mjs';
import { snapshot,settle } from './journal.mjs';
import { CONFIG } from '../../js/config.js';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const DATA=join(ROOT,'lab-data'),RUNS=join(ROOT,'lab-runs'),PAPER=join(ROOT,'lab-paper');
const args=process.argv.slice(2),command=args[0]||'help';
const option=(key,fallback)=>{const i=args.indexOf('--'+key);if(i<0)return fallback;if(!args[i+1]||args[i+1].startsWith('--'))throw Error(`--${key} 값 필요`);return args[i+1];};

async function provenance(config) {
  let commit='unavailable',dirty=true;
  try {
    const git=(...a)=>execFileSync('git',['-c','safe.directory='+ROOT.replaceAll('\\','/'),...a],{cwd:ROOT,encoding:'utf8'}).trim();
    commit=git('rev-parse','HEAD');dirty=Boolean(git('status','--porcelain'));
  } catch { /* hashes below remain sufficient to identify source contents */ }
  const hashes={};
  async function walk(dir) {
    for(const e of await readdir(join(ROOT,dir),{withFileTypes:true})) {
      const rel=join(dir,e.name);
      if(e.isDirectory())await walk(rel);
      else if(/\.(m?js|json)$/.test(e.name))hashes[rel.replaceAll('\\','/')]=digest(await readFile(join(ROOT,rel)));
    }
  }
  await walk('js');await walk('research/lab');
  return {commit,dirty,node:process.version,configHash:digest(JSON.stringify(config)),sourceHashes:hashes};
}

async function run(config,id) {
  const dataset=await loadDataset(DATA,id);
  if(dataset.manifest.start!==Date.parse(config.start)||dataset.manifest.end!==Date.parse(config.end)
    || [...dataset.series.keys()].join('|')!==config.symbols.join('|')) throw Error('설정과 데이터셋의 기간/종목이 다릅니다. collect를 먼저 실행하세요.');
  const source=await provenance(config),createdAt=new Date().toISOString();
  const idRun=createdAt.replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8),dir=join(RUNS,idRun);
  console.log('시간순 백테스트 시작 · 전체 시장 순위/계좌 수익 재현 아님');
  const result=backtest(dataset,config,s=>console.log('분석 중: '+s));
  const report={schema:1,id:idRun,createdAt,config,scannerConfig:CONFIG,provenance:source,dataset:dataset.manifest,...result};
  await writeReport(dir,report);await writeJson(join(RUNS,'latest.json'),{id:idRun});
  console.log(JSON.stringify(result.comparison.filter(r=>r.split==='test'),null,2));
  console.log('보고서: '+join(dir,'index.html'));
}

async function serve(port) {
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('port는 1024~65535');
  await mkdir(RUNS,{recursive:true});
  createServer(async(req,res)=>{
    try {
      if(req.method!=='GET') {res.writeHead(405);res.end();return;}
      const url=new URL(req.url,'http://localhost');
      let bytes,type='text/html; charset=utf-8';
      if(url.pathname==='/') {
        const folders=(await readdir(RUNS,{withFileTypes:true})).filter(e=>e.isDirectory()&&/^[\w-]+$/.test(e.name)).map(e=>e.name).sort().reverse();
        let snaps=0,outs=0;
        try {snaps=(await readdir(join(PAPER,'snapshots'))).length;}catch{}
        try {outs=(await readdir(join(PAPER,'outcomes'))).length;}catch{}
        bytes=`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QAR 연구실</title><style>body{font:16px/1.7 system-ui;background:#f4f6fa;color:#142033;max-width:960px;margin:40px auto;padding:20px}li{background:white;padding:18px;margin:12px 0;border-radius:10px;overflow-wrap:anywhere}a{color:#185ab5}code{background:#e7edf6;padding:3px}</style><h1>QAR 연구실</h1><p>과거 문제 → 같은 조건으로 채점 → 모의시험 기록</p><p>모의 관측 ${snaps}회 · 결말 기록 ${outs}건. 원본은 lab-paper 폴더에 보존됩니다. 반복 관측은 독립 거래가 아니므로 건수를 승률로 해석하지 마세요.</p><p>새 관측: <code>lab.cmd paper-snapshot</code> · 결말 확인: <code>lab.cmd paper-settle</code></p><h2>실험 성적표</h2><ul>${folders.map(f=>`<li><a href="/${f}/index.html">${f}</a></li>`).join('')||'<li>lab.cmd all 실행 후 결과가 나타납니다.</li>'}</ul><p>자동 주문·자동 전략 배포는 없습니다. 이 서버는 내 PC의 127.0.0.1에서만 열립니다.</p></html>`;
      } else {
        const path=resolve(RUNS,'.'+decodeURIComponent(url.pathname));
        if(!path.startsWith(resolve(RUNS)+sep)||!['.html','.json','.jsonl','.csv'].some(ext=>path.endsWith(ext))) {res.writeHead(403);res.end();return;}
        bytes=await readFile(path);type=path.endsWith('.html')?type:path.endsWith('.csv')?'text/csv; charset=utf-8':'application/json; charset=utf-8';
      }
      res.writeHead(200,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(bytes);
    } catch(e) {res.writeHead(e.code==='ENOENT'?404:500);res.end('자료를 읽을 수 없습니다.');}
  }).listen(port,'127.0.0.1',()=>console.log(`연구실: http://127.0.0.1:${port} · 종료 Ctrl+C`));
}

async function main() {
  if(command==='help') {console.log(`QAR 연구 환경 (Node 20+ / 추가 패키지·개인 API 키 없음)
  lab.cmd doctor             실행 환경 확인
  lab.cmd collect            공개 시세 수집·검사·저장
  lab.cmd run                저장된 자료로 전략 비교 (네트워크 없음)
  lab.cmd all                collect + run
  lab.cmd serve              연구 성적표 열기 (127.0.0.1:8876)
  lab.cmd paper-snapshot     현재 신호/확률을 변경 불가 원본으로 저장
  lab.cmd paper-settle       만기가 지난 관측의 결말을 별도 파일로 저장
옵션: --config 파일.json / run --data 데이터셋ID / serve --port 8876
설정: research/lab/config.json · 사용법: research/lab/README.md
테스트: node --test research/lab/tests.mjs`);return;}
  if(command==='serve')return serve(Number(option('port','8876')));
  const config=validateConfig(await readJson(resolve(option('config',join(ROOT,'research/lab/config.json')))));
  if(command==='doctor') {console.log(JSON.stringify({node:process.version,root:ROOT,config:config.name,data:DATA,reports:RUNS,paper:PAPER,ready:typeof fetch==='function'},null,2));return;}
  if(command==='collect'||command==='all') {const data=await collect(config,DATA);if(command==='all')await run(config,data.manifest.id);return;}
  if(command==='run')return run(config,option('data',undefined));
  if(command==='paper-snapshot')return console.log(await snapshot(config,PAPER,await provenance(config)));
  if(command==='paper-settle')return console.log(await settle(PAPER));
  throw Error('알 수 없는 명령: '+command);
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
