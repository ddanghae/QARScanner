import { writeFile,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJson } from './data.mjs';

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=v=>Number.isFinite(v)?v.toFixed(3):'—';
const percent=v=>Number.isFinite(v)?(v*100).toFixed(1)+'%':'—';
const names={reversal:'반등',reversal_crt:'반등 + CRT',early:'조기 포착',early_crt:'조기 + CRT',pump_fade:'급등 후 급락',pump_fade_crt:'급락 + CRT',crt_only:'CRT 단독'};
export function csv(rows) {
  if(!rows.length) return '';
  const keys=Object.keys(rows[0]);
  const cell=v=>'"'+String(v??'').replaceAll('"','""')+'"';
  return '\ufeff'+[keys,...rows.map(r=>keys.map(k=>typeof r[k]==='object'?JSON.stringify(r[k]):r[k]))].map(r=>r.map(cell).join(',')).join('\n');
}

export async function writeReport(dir,run) {
  await mkdir(dir,{recursive:true});
  await writeJson(join(dir,'run.json'),run);
  await writeFile(join(dir,'comparison.csv'),csv(run.comparison));
  await writeFile(join(dir,'trades.jsonl'),run.trades.map(t=>JSON.stringify(t)).join('\n'));
  const test=run.comparison.filter(r=>r.split==='test');
  const table=rows=>`<div class="table-wrap"><table><thead><tr><th>전략</th><th>시도</th><th>확정</th><th>모호</th><th>미완료</th><th>계획 불가</th><th>승률</th><th>평균 R</th><th>PF</th><th>거래순 낙폭 R*</th><th>판정</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(names[r.strategy])}</td><td>${r.signals}</td><td>${r.resolved}</td><td>${r.ambiguous}</td><td>${r.incomplete}</td><td>${r.invalid}</td><td>${percent(r.winRate)}</td><td>${number(r.meanR)}</td><td>${number(r.profitFactor)}</td><td>${number(r.tradeOrderDrawdownR)}</td><td>${r.qualified?'표본 기준 충족 · 별도 검토':'표본 부족'}</td></tr>`).join('')}</tbody></table></div>`;
  const quality=run.dataset.symbols.map(s=>`<tr><td>${esc(s.symbol)}</td><td>${s.quality.rows}</td><td>${percent(s.quality.coverage)}</td><td>${s.quality.missing}</td><td>${s.quality.duplicates}</td><td>${s.quality.invalid}</td></tr>`).join('');
  const html=`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QAR 연구 성적표</title>
<style>body{font:15px/1.65 system-ui,sans-serif;background:#f4f6fa;color:#142033;margin:0}main{max-width:1250px;margin:auto;padding:28px}h1{font-size:28px}h2{font-size:20px}section{background:white;border:1px solid #dce3ed;border-radius:14px;padding:22px;margin:20px 0}.notice{background:#fff3d5;padding:16px;border-radius:10px}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:right;padding:10px;border-bottom:1px solid #e6eaf0;white-space:nowrap}th:first-child,td:first-child{text-align:left}small,.muted{color:#586777}a{color:#185ab5}code{overflow-wrap:anywhere}summary{cursor:pointer;font-weight:bold}li{margin:8px 0}</style>
<main><h1>QAR 연구 성적표</h1><p>${esc(run.config.name)} · ${esc(run.config.symbols.join(', '))} · ${esc(run.createdAt)}</p>
<p class="notice">이 결과는 연구 환경의 실험입니다. 현재 선택한 종목의 조건을 비교하며, 전체 시장 순위·유동성 상위 선별을 재현한 서비스 성적은 아닙니다. 표본이 적거나 모호한 거래가 많으면 우열을 결정할 수 없습니다.</p>
<section><h2>마지막 시험 구간의 성적</h2><p>고정 규칙으로 시간순 ${run.config.splitFractions.map(f=>Math.round(f*100)).join('/')} 분할을 사용했습니다. 자동 학습·최적화·최우수 전략 선정은 하지 않습니다. 이 구간을 반복해서 보고 규칙을 바꾸면 새 미사용 시험 기간이 필요합니다.</p>${table(test)}
<p class="muted">R은 최초 손절 거리 1개에 해당합니다. 비용을 뺀 평균 R이며 모호·미완료·계획 불가 거래는 평균과 승률에서 제외하고 개수를 따로 표시합니다. PF는 손실이 없으면 —입니다. *거래순 낙폭은 동시 보유를 합친 계좌 낙폭이 아닙니다.</p></section>
<section><h2>비교 조건</h2><ul><li>판정 간격 ${run.config.evaluationMinutes}분, 준비 구간 ${run.config.warmupDays}일, 모든 전략 최대 보유 ${run.config.holdHours}시간.</li><li>다음 5분봉 시가로 모의 진입. 원래 지정가 주문 체결을 재현하지 않습니다. 기존 가격 수준은 고정하고 잘못된 목표/손절 배치는 계획 불가로 제외합니다.</li><li>왕복 수수료·슬리피지 ${2*(run.config.feeBpsPerSide+run.config.slippageBpsPerSide)/100}%. 펀딩·시장 충격·실제 호가·청산은 미포함. 무레버리지 가격 경로 실험입니다.</li><li>목표 1에서 계획 비중(미지정은 절반)을 청산하고 잔량 손절을 기준가로 이동. 같은 봉의 순서를 알 수 없으면 모호 사례로 처리합니다.</li><li>전략별·코인별 동시 보유 1개. 모호한 거래는 최대 보유시간까지 신규 진입을 막습니다.</li><li>‘기존 + CRT’는 같은 방향 CRT 확인만 추가하고 기존 청산 계획을 유지합니다. CRT 단독만 CRT 전용 목표를 씁니다.</li><li>분할 경계 앞 ${run.config.holdHours}시간 신호를 제외했습니다. 제외 판정 시점 ${run.counts.purged}개.</li><li>조기 전략은 원래 대형 코인을 제외하므로 BTC·ETH 파일만 있으면 0건이 정상입니다. 24시간 제한은 원래 조기 전략의 최대 보유 기간보다 짧습니다.</li></ul></section>
<section><h2>과거 개발·검증 구간</h2>${['train','validation'].map(split=>`<details><summary>${split}</summary>${table(run.comparison.filter(r=>r.split===split))}</details>`).join('')}</section>
<section><h2>데이터 검사</h2><p>UTC 5분봉 한 행 = 한 코인의 한 봉. 15분·1시간·4시간은 이 자료에서 완성된 구간만 집계했습니다.</p><div class="table-wrap"><table><tr><th>코인</th><th>행</th><th>수집률</th><th>누락</th><th>중복</th><th>비정상</th></tr>${quality}</table></div><p>${esc(run.dataset.universePolicy)}</p></section>
<section><h2>재현 정보와 내려받기</h2><p>기간 ${esc(new Date(run.dataset.start).toISOString())} ~ ${esc(new Date(run.dataset.end).toISOString())} (끝 미포함)</p><p>코드 ${esc(run.provenance.commit)} · 설정 해시 <code>${esc(run.provenance.configHash)}</code></p><p>코드 파일별 해시·데이터 체크섬·분할 시각은 원본 결과에 포함됩니다.</p><a href="run.json">원본 결과 JSON</a> · <a href="comparison.csv">비교표 CSV</a> · <a href="trades.jsonl">거래별 근거 JSONL</a></section></main></html>`;
  await writeFile(join(dir,'index.html'),html);
}
