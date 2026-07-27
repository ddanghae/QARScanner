# Claude early 튜닝 + QAR/Pine v3.4 통합 PRD 부록

작성일: 2026-07-27
대상 저장소: `ddanghae/QARScanner`
상태: 구현·검증 완료 — 로컬 병합 커밋 포함, 원격 push 제외

## 1. 문제

로컬 `main`의 QAR/Pine v3.4 정합성 커밋과 `origin/main`의 Claude Code early 튜닝
3개 커밋이 공통 기준 커밋에서 분기됐다. 원격 변경에는 OI 72시간 데이터 창과 EMA200
기울기 창을 바로잡는 유효한 수정이 있지만, 그대로 병합하면 다음 문제가 남는다.

1. early 모드에서 화면의 최소 점수 선택기가 실제 컷에 영향을 주지 않는다.
2. 돌파 후보를 살리기 위한 압축 완화가 1단계 매집 조건까지 완화한다.
3. early 점수를 진행 단계 사다리로 설명하지만 실제 계산은 근거 품질 점수다.
4. OI 누락이 실제 미세 감소보다 유리하고, 72시간 변화가 timestamp가 아닌 행 번호에 의존한다.
5. early 저점수 후보가 공통 등급상 `제외`로 표시된다.
6. 압축 우선 50개 제한이 이미 돌파 중인 후보를 밀어낼 수 있다.
7. 원격 이력을 통째로 채택하면 로컬 Pine v3.4, VERIFY, PRD와 15분봉 handoff 계약이 사라진다.

이번 작업은 후보 수나 승률 개선을 주장하지 않는다. 두 이력을 안전하게 통합하고 화면 설명과
실제 판정, 데이터 품질 정책을 일치시키는 것이 목적이다.

## 2. 성공 기준

1. Pine v3.3/v3.4, VERIFY, 기존 PRD와 심볼·15분봉 handoff가 보존된다.
2. `oiLimit=80`, 4시간봉 250개, 설정 기반 OI 만점 기준과 원격 회귀 테스트가 보존된다.
3. early 모드에서는 별도 최소 점수 선택기를 숨기고 채점 강도의 실제 early 컷을 표시한다.
4. 압축 기준은 후보 선별 60, 1단계 매집 30, 2단계 임박 15로 분리한다.
5. OI와 필수 지표 이력이 부족하면 early 후보를 만들지 않는 fail-closed 정책을 적용한다.
6. OI 72h/12h 변화는 timestamp 기준 목표 시각에 충분히 가까운 표본으로 계산한다.
7. early 점수는 진행 단계가 아니라 근거 품질임을 UI와 문서에 명시한다.
8. early 전용 중립 등급을 사용해 표시 후보가 공통 `제외` 등급을 받지 않는다.
9. 후보 상한 적용 전 확인된 돌파 후보를 우선하고, 그다음 압축이 강한 후보를 정렬한다.
10. 병합본 전체 테스트, 변경 JavaScript 구문 검사, reversal/early 스모크가 통과한다.
    `git diff --check`는 byte-preserved Pine의 문서화된 기존 공백 주석 6줄을 제외한
    staged 변경에서 통과한다.

## 3. 범위

- `js/config.js`: early 후보/매집 압축 기준, OI 표본 허용오차, early 등급과 컷 설정
- `js/core/early-detect.js`: timestamp 기반 OI, 데이터 준비 상태, early 전용 등급
- `js/scanner/prefilter.js`: 후보 선별용 완화 기준과 돌파 우선순위용 메타데이터
- `js/scanner/scan-controller.js`: 돌파 우선 후보 정렬과 early 컷 적용
- `js/ui/settings.js`, `index.html`, `css/style.css`: early 최소 점수 UI 정합성
- 테스트와 README/PROGRESS/VERIFY/PRD 수치 및 설명
- Git 분기 이력의 수동 충돌 해결과 단일 로컬 병합 커밋

## 4. 비범위

- Pine v3.4 판정 로직 또는 로그인된 TradingView 저장본 변경
- early 로직을 Pine/QAR Sync로 포팅
- 자동 주문, 계정, 포지션, 레버리지, API 키
- 점수를 승률·상승 확률·수익 보장으로 표현
- 결과 데이터 없이 가중치 자체를 성과 최적화
- GitHub 원격 push

## 5. 제약 조건

1. Binance 공개 데이터와 기본 마감 캔들 원칙을 유지한다.
2. 정적 GitHub Pages 구조와 기존 결과 객체 호환성을 유지한다.
3. 수치 기준은 `js/config.js`에 두고 계산 코드에 새 임계값을 하드코딩하지 않는다.
4. OI 누락과 지표 이력 부족은 좋은 신호로 간주하지 않는다.
5. 로컬 `main`과 `origin/main` 이력을 재작성하거나 강제 덮어쓰지 않는다.
6. 사용자 소유의 무관한 변경은 수정하거나 커밋하지 않는다.

## 6. 구현 계획

1. `origin/main`에서 `codex/integrate-claude-early` 브랜치를 만든다.
2. 로컬 `main`을 `--no-commit`으로 병합해 두 부모 이력을 보존한다.
3. `js/config.js`, `PROGRESS.md` 충돌을 기능 합집합으로 해결한다.
4. 회귀 테스트를 먼저 추가하고 early 로직·UI·등급을 수정한다.
5. Pine/handoff 파일이 로컬 커밋과 동일하게 보존됐는지 확인한다.
6. 전체 자동검증과 모드별 스모크 후 실제 수치로 문서를 갱신한다.
7. 모든 검증이 통과한 경우에만 하나의 로컬 병합 커밋을 생성한다.

## 7. 검증 기준

- 통합 전 `origin/main` 90개와 로컬 `deecc31` 100개의 중복 제외 병합 기초
  기대치 104개를 모두 보존한다.
- 최소 점수 UI, stage별 압축 경계, OI 누락/불규칙 timestamp, early 등급,
  돌파 후보 우선순위를 추가 테스트한다.
- 변경 JavaScript 전체 `node --check`
- byte-preserved Pine의 문서화된 기존 공백 주석 6줄을 제외한 staged `git diff --check`
- reversal/early 양 모드의 순수 함수·필터 스모크
- Pine v3.4가 `deecc31` Git blob과 동일하고 1,928줄인지 확인하며, 현재 작업 파일의
  실제 SHA256을 기록한다.

## 8. 위험과 복구

- 병합은 별도 브랜치에서 수행해 로컬 `main`과 `origin/main`을 그대로 보존한다.
- 충돌 해결에서 한쪽 파일을 통째로 선택하지 않고 기능 단위로 합친다.
- 검증 실패 시 병합 커밋을 만들지 않으며 기존 두 브랜치에는 영향이 없다.
- 원격 push와 TradingView 저장은 하지 않는다.

## 9. 미해결 질문

없음. 승인된 기본값은 early 필수 데이터 fail-closed, 단계와 품질 점수 분리,
별도 통합 브랜치, 단일 로컬 병합 커밋, 원격 push 제외다.

## 10. 승인 기록

사용자 승인: `실행` (2026-07-27)

## 11. 구현 결과

- `codex/integrate-claude-early`에서 `origin/main`과 로컬 `main`의 두 부모 이력을
  기능 단위로 통합했다.
- OI timestamp 허용오차, 필수 자료 fail-closed, 압축 역할 분리, early 전용 등급,
  돌파 우선 상한, 모드별 점수 UI를 구현했다.
- `node tests/run.js`: `118/118` 통과
- 전체 JavaScript 39개 `node --check`: 통과
- byte-preserved Pine 두 파일을 제외한 staged `git diff --check`와 충돌 마커 검사: 통과
- 전체 staged `git diff --check`는 새로 추가되는 Pine 원본의 기존 공백 주석 6줄을 보고한다.
  `deecc31` Git blob 보존을 우선해 해당 줄은 정규화하지 않았다.
- reversal/early 순수 함수 스모크: 통과
- 1280×760 headless Chromium에서 reversal stage 5 → early 전환 시 단계 필터 `전체`
  정상화, 수동 점수 입력 숨김·비활성화, 품질 컷 `40+` 표시를 확인했다. 페이지 오류와
  4xx 응답은 0건이었다.
- Pine v3.3/v3.4 Git blob은 `deecc31`과 동일하다. v3.4는 1,928줄이며 현재 Windows
  작업 파일 SHA256은 `CD0DA0FF7EB7865D77BD1EC43757852FAABE80B97341E2A5E6D469D9EB6471DD`다.
- 문서에 과거 기록된 `4F141C0F...`와 TradingView revision 7의 바이트 동일성은
  재현되지 않아 `tradingview/VERIFY.md`에 미확인으로 명시했다.
- 원격 push와 TradingView 저장본 변경은 수행하지 않았다.
