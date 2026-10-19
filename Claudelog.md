# Claudelog: AI 사무실 작업 기록과 현황

다른 Claude나 Codex가 이어서 작업할 수 있게 정리한 인수인계 문서다. 마지막 정리: **2026-10-19** (커밋 `b51314e` 기준, 이 문서 커밋 직전).
저장소는 **공개**(https://github.com/mightycha0826/LINDA_AI-OFFICE)다. 토큰, 비밀번호, 개인 ID는 여기에 적지 않는다.

---

## 1. 이 프로젝트가 무엇인가

주인(CEO) 한 명이 Discord로 지시하면, AI 직원들이 계획 → 결재 → 개발 → 검토 → 푸시까지 하는 "AI 회사" 시스템이다.

- **설계 기준**: `docs/DESIGN.md` (1~18장). 설계와 다르게 만들려면 먼저 주인에게 묻는다.
- **작업 규칙**: `CLAUDE.md`
  - 안전 규칙(5·7·8·11장)은 반드시 테스트와 함께 만든다.
  - 상태 전환, 결재, 한도, 푸시 권한은 코드로만 집행한다.
  - `design-systems/point/`는 읽기 전용이다.
- **진행 단계**: DESIGN.md 16장의 0~6단계. **1~6단계 코드는 모두 완성**됐다. 지금은 0단계(실제 환경 검증)와 실제 운영 연결을 마무리하는 중이다.

### 직원 구성 (seed.ts)

| ID | 역할 | 두뇌 |
| --- | --- | --- |
| chief-of-staff | 비서실장 | 헤르메스 + Qwen3-14B (헤르메스 미설치) |
| pm | PM | Ollama qwen3:14b |
| developer | 개발자 | Claude Code (`claude -p`) |
| reviewer | 리뷰어·감사관 | Codex (`codex exec`, 읽기 전용) |
| marketing | 마케팅 | Ollama qwen3:14b |
| strategy | 경영전략·리서치 | Claude |
| qa-local | 검토 담당 | Ollama gemma4:12b |
| git-cat | Git 고양이 | 코드 (오케스트레이터 모듈) |
| temp-1~4 | 임시 직원 | 계획서가 정함 |

---

## 2. 위치

| 경로 | 내용 |
| --- | --- |
| `C:\ai-office\office` | **이 저장소** (npm workspaces, TypeScript, Node 24) |
| `C:\ai-office\data` | 운영 데이터, 저장소 밖: `config.json`, `secrets.json`(비밀), `office.db`(SQLite), `codex-home\`(회사 전용 Codex 로그인) |
| `C:\ai-office\repos` | 등록 프로젝트 저장소 (지금은 시험 찌꺼기 `smoke-20261019015134`만 있음, 지워도 됨) |
| `C:\ai-office\wt` | 티켓 worktree (`T-n`), `_sandbox`, `_smoke` |
| `C:\ai-office\backups` | 헤르메스 백업, `smoke-leftovers-20261019`(옮겨 둔 시험 worktree) |
| `C:\Users\Aranea\Desktop\ai-office` | Claude 데스크톱 세션의 작업 폴더. 원본 설계 패키지와 `설계 변경 대기 목록.md`, `.claude/launch.json`(화면 데모 미리보기) |

### 패키지 구조

- `packages/shared`: Zod 스키마와 타입 (도메인, 이벤트, AI 출력, 화면 스냅샷)
- `packages/orchestrator`: 유일한 DB 쓰기 주체
  - `core/`: 전환표, 티켓, 계획, 결재, 한도, 가드, 회의, 지시
  - `brains/`: ollama, claude-code, codex, mock, GPU 대기열
  - `staff/`: 역할 카드, 프롬프트
  - `discord/`: 시스템 봇, 거울, 알림, 슬래시 명령
  - `chief/`: 비서실장 도구, 보고
  - `mcp/`: 비서실장 MCP 서버 (stdio → 내부 API)
  - `gitcat/`: 푸시, 병합, 되돌리기
  - `workspace/`: worktree, 테스트 실행기
  - `retro/`: 회고, 규칙
  - `screen/`, `http/`: 화면 서버
  - `design/`: 디자인 시스템 lint
  - `sim/`: run, screen-demo, smoke
- `packages/office-ui`: Vite + React 19 + Motion. 사무실 화면은 보기 전용이다.
- `assets/characters/<id>/`: 스프라이트 (manifest.json + 동작별 PNG)
- `assets/sources/`: 캐릭터 원본 시트
- `stage0/`: 0단계 검증 스크립트와 `RESULTS.md`
- `scripts/`:
  - `set-secrets.ps1`: 비밀 값 입력
  - `hermes-configure.ps1`: 헤르메스 연결
  - `slice-sprite-sheet.py`: 스프라이트 자르기
  - `make-placeholder-sprites.mjs`: 임시 단색 스프라이트
- `docs/`:
  - `DESIGN.md`: 설계
  - `RUNNING.md`: 실행 안내
  - `AUTONOMOUS-LOG.md`: 단계별 자율 결정 R~AS
  - `CHARACTER-PROMPTS.md`: 캐릭터 그림 요청 프롬프트
  - `HERMES-SETUP.md`: 헤르메스 설치와 연결
  - `config.example.json`: 설정 예시

---

## 3. 지금 상태 (2026-10-19)

### 돌아가는 것
- **오케스트레이터 실운영 중**: pm2 앱 `ai-office` (`ecosystem.config.cjs`, `pm2 save` 됨). 이 프로세스가 함께 띄우는 것:
  - 사무실 화면 http://127.0.0.1:8780
  - 내부 API 127.0.0.1:8790
  - Discord 시스템 봇 **LINDA#9825**
- **Discord**:
  - 비공개 서버와 채널 5개(#비서실, #결재함, #보고, #막힘, #사무실-대화)를 만들었다.
  - ID는 `C:\ai-office\data\config.json`에 있다.
  - 봇 토큰과 #사무실-대화 웹훅은 `secrets.json`에 있다.
  - 슬래시 명령이 등록됐다. 주인이 `/상태`로 응답을 확인했다.
- **로컬 모델**: Ollama 0.40.5, `qwen3:14b`(9.3GB), `gemma4:12b`(8.0GB). C: 여유 약 62GB.
- **로그인**:
  - Claude Code: 주인 Pro 계정 (기본 모델 Opus, `config.claude.model` 비어 있음)
  - Codex: 회사 전용 `CODEX_HOME`에 로그인됨, 기본 스킬·플러그인은 끔

### 테스트
- `npm test` → **405개 통과**, `npm run typecheck` 깨끗, `npm run lint:ds` 통과.

### 0단계 결과 (`stage0/RESULTS.md`)

| # | 항목 | 결과 |
| --- | --- | --- |
| 환경 | env.ps1 | RAM 64GB, RTX 3060 12GB. C: 확보 완료 |
| #1 | 헤르메스 도구 호출 | **미실행** (헤르메스 미설치) |
| #2 | 모델 교체 속도 | **통과** (교체 4~7초, 기준 30초) |
| #3 | RAM | **통과** (최소 39GB 남음, 페이지 파일 거의 0) |
| #4 | Claude Code 자동 실행 | **통과** (push 차단 확인) |
| #5 | Claude 사용량 읽기 | **통과** (stream-json `rate_limit_event`). 상태줄 비교는 주인 몫 |
| #6 | Codex 읽기 전용 | **통과** (회사 CODEX_HOME으로 재확인, 입력 토큰 75,764 → 42,290) |
| #7 | 헤르메스 Discord | **미실행** |
| #8 | 학교 네트워크 | **통과** (낮). 밤 재측정 남음 |
| #9 | 구독 약관 | 조사 요약 완료, 최종 판단은 주인 |
| #10 | SearXNG | **보류**. WSL이 없어 Docker 설치에 관리자 승인과 재부팅 필요 |

- 전체 흐름 시험(`npm run smoke -- --flow`, 메모리 DB):
  - 두뇌 5종 연결은 통과했다.
  - **티켓 3개가 모두 `paused(cap)`**: Claude Code 한 번 호출이 입력 40~51k토큰(대부분 캐시 읽기)으로 잡혀, 토큰 상한(PM 예상치×2, 최소 2만)을 첫 호출에 넘었다.
  - **주인 결정: 상한은 설계 그대로 둔다.** 계산 방식이나 숫자를 바꾸자고 제안하지 않는다.
  - 대안(주인 승인 필요): PM 안내문에 "Claude Code 1회 약 4~5만 토큰"을 넣어 예상치를 현실화하는 것.

### 캐릭터
- **진짜 그림**: `chief-of-staff`, `pm` (옆모습과 정면). 나머지는 단색 임시 그림이다.
- 정면 그림은 선택 기능이다:
  - 키 `<동작>-front`. 멈춰 있을 때와 아래로 걸을 때 정면을 쓴다.
  - 정면이 없으면 오른쪽 그림으로 대신한다. 왼쪽은 반전한다.
- 새 캐릭터 만드는 법:
  1. `docs/CHARACTER-PROMPTS.md`의 통합 프롬프트(1536×1024, 왼쪽 6열 옆모습, 오른쪽 6열 정면, 투명 배경)로 ChatGPT에 요청한다.
  2. `python scripts/slice-sprite-sheet.py <시트> <id> --both`로 자른다.
  3. `scripts/make-placeholder-sprites.mjs`의 SETS에서 그 id를 뺀다.

---

## 4. 작업 이력 (커밋 순)

| 날짜 | 커밋 | 내용 |
| --- | --- | --- |
| 10-15 | b093556 | 저장소 시작, 0단계 체크리스트·스크립트 |
| 10-15 | d569abd | 1단계 오케스트레이터 핵심 (전환표, 결재, 한도, 가드, MockLLM) |
| 10-15 | 3c60f47 | 2단계 직원 연결 (Ollama, Claude Code, Codex 어댑터) |
| 10-16 | 699ff7d | 2.5단계 임시 직원과 웹 검색 |
| 10-16 | b2d51ca | 3단계 Discord (결재 봇, 알림, 거울, 정기 보고, 비서실장 MCP) |
| 10-16 | 7825dd6 | 4단계 Git 고양이 (squash, gitleaks, 푸시·main 병합·되돌리기) |
| 10-16 | 0cddbdf | 5단계 사무실 화면 (스냅샷·SSE, 지도, 스프라이트, 포인트 디자인 시스템) |
| 10-16 | 4a612ff | 6단계 회고와 학습 (규칙 후보 → 결재, 효과 측정, 헤르메스 백업) |
| 10-16 | 320884e~40792b2 | 실행 문서, 화면 접근성, 오른쪽 패널 접기 |
| 10-16~17 | 4f0a435~0bbab50 | 0단계 #4·#5·#6·#8, 개인 설정 분리, 실측 사용량 |
| 10-18~19 | 9baf7e8~9f74556 | 캐릭터 그림 (비서실장, PM), 정면 지원, 자르기 도구 |
| 10-19 | 2bd0b70 | `set-secrets.ps1` |
| 10-19 | b856138, 38d4e45, d764cd7 | 회사 CODEX_HOME 재확인, 기본 스킬·플러그인 끄기, e2e가 진짜 CODEX_HOME을 안 쓰게 |
| 10-19 | 54cdeb8 | 0단계 #2·#3 통과, 전체 흐름 시험 결과 |
| 10-19 | 79d5ced | **버그 수정**: 남은 worktree 폴더(다른 저장소·브랜치)를 그대로 쓰지 않음, smoke는 `wt\_smoke` 사용 |
| 10-19 | 8a68a9c | #9 약관 조사 |
| 10-19 | 3f4ad5e | **`/지시` 슬래시 명령** (헤르메스 없이 CEO가 직접 지시) |
| 10-19 | b51314e | 헤르메스 설치 안내와 연결 스크립트 |

- GitHub에는 `8a68a9c`까지 푸시됐다. `3f4ad5e` 이후는 로컬에만 있다(푸시는 주인 승인 후에만).
- 단계별 세부 결정(R~AS): `docs/AUTONOMOUS-LOG.md`. 설계 반영 기록: Desktop의 `설계 변경 대기 목록.md`.

---

## 5. 실행 방법 (요약, 자세히는 docs/RUNNING.md)

```
npm test                      # 테스트
npm run typecheck
npm run lint:ds               # 화면 디자인 시스템 검사
npm run build:screen          # 화면 빌드 (오케스트레이터가 dist를 낸다)
npm run demo:screen           # 가짜 직원 화면 데모 (8780, 실운영과 포트 충돌, 운영 중엔 끄고)
npm run smoke -- --config C:\ai-office\data\config.json [--only ollama|claude|codex] [--flow]
pm2 restart ai-office         # 코드 바꾼 뒤 실운영 반영
pm2 logs ai-office --lines 30 --nostream
```

- 로그: `C:\Users\Aranea\.pm2\logs\ai-office-out.log`, `-error.log`
- Discord 명령: `/지시`, `/보고`, `/상태 T-n`, `/push T-n`, `/되돌리기 T-n`, `/한도`, `/정지`, `/재개`, `/프로젝트`, `/설정`
- **등록된 프로젝트가 아직 없다.** 코딩 지시를 하려면 먼저 `/프로젝트`로 GitHub 저장소를 등록해야 한다.

---

## 6. 꼭 지킬 것 (주인 선호와 안전 규칙)

- **주인에게는 한국어로 답한다** (요약과 질문 상자 포함).
- **안전 한도는 설계대로**: 티켓 토큰 상한(예상치×2, 최소 2만), 턴 40. 숫자는 주인이 `/설정`으로 바꾼다.
- **비밀 값**:
  - 토큰과 웹훅을 AI가 직접 입력하지 않는다. 채팅으로 받지도 않는다.
  - 주인이 `scripts/set-secrets.ps1`(회사 봇), `scripts/hermes-configure.ps1`(비서실장 봇)로 넣는다.
  - `secrets.json`을 메모장으로 고치지 않는다. 그래야 BOM 없는 UTF-8이 유지된다.
- **LINDA(시스템 봇)는 Message Content Intent를 끈 채로** 둔다. 결재는 버튼 클릭으로만 한다.
- **푸시는 매번 주인 승인을 받는다.** 저장소가 공개이니 푸시 전에 `gitleaks git --log-opts=origin/main..main`을 실행한다.
- Windows 자격 증명 관리자의 GitHub 항목은 주인 결정 사항이다. 지우지 않는다.
- `design-systems/point/`는 고치지 않는다. 임시 스타일은 `office-ui/src/styles/point.extra.css`에 두고 주인 승인을 기다린다.

## 7. 환경에서 알게 된 함정

- **Claude Code의 Bash/PowerShell은 샌드박스**다.
  - 전역 npm 설치나 실제 사용자 셸이 필요한 일은 **Terminal 패널**(`run_in_terminal`)에서 한다.
  - `C:\ai-office` 파일 쓰기는 실제로 반영된다.
- `run_in_terminal`은 파이프(`|`)와 변수를 막는다. 리디렉션(`*>`)을 쓰거나 .ps1 파일로 만들어 실행한다.
- PowerShell 리디렉션 결과는 UTF-16이라 한글이 깨져 보인다. Python으로 `utf-16`을 읽거나 Tee 없이 Node가 직접 파일로 쓰게 한다.
- Windows PowerShell 5.1:
  - 한글이 든 `.ps1`은 **UTF-8 BOM**이 필요하다.
  - JSON은 `ConvertTo-Json` 대신 Node로 쓴다. 그래야 배열과 이스케이프가 바뀌지 않는다.
- 세션 환경 변수 `CLAUDE_*`, `ANTHROPIC_BASE_URL`이 자식에게 넘어가면 Claude 로그인이 안 된 것처럼 보인다. 오케스트레이터는 허용 목록(`safeEnv`)으로 막는다.
- **Codex**:
  - 회사 전용 `C:\ai-office\data\codex-home`을 쓴다. 주인 `~/.codex`의 플러그인·MCP·`gpt-5.4` 설정을 물려받지 않게 하려는 것이다.
  - Windows 샌드박스가 `-C`를 무시해서, 프롬프트에 작업 폴더 절대 경로를 넣는다.
- **Claude**: 개인 설정 분리 옵션 `--setting-sources project,local --strict-mcp-config --disable-slash-commands`. 이것 없이는 캐시 생성이 185k토큰, 있으면 7k토큰이다.
- **헤드리스 Edge 스크린샷**은 캐릭터가 그려지기 전에 찍히는 경우가 많다. 앱 내 브라우저 창이 숨겨져 있으면 스크린샷이 안 된다. 미리보기 PNG를 직접 합성해서 보내는 편이 확실하다.
- 헤르메스 설치 스크립트(`iex (irm …)`)는 자동 모드 분류기가 막는다. 주인이 직접 실행한다.

---

## 8. 남은 일

### 주인이 해야 하는 것
1. **헤르메스 설치** (`docs/HERMES-SETUP.md`):
   - 비서실장 봇 앱을 새로 만든다. 이 봇은 Message Content와 Server Members 인텐트를 켠다.
   - `iex (irm https://hermes-agent.nousresearch.com/install.ps1)`
   - `hermes model`: `http://127.0.0.1:11434/v1`, `qwen3:14b`
   - `scripts/hermes-configure.ps1`
   - `hermes gateway`
2. `/프로젝트`로 일할 저장소를 등록한다.
3. Docker/SearXNG: PC 앞에서 관리자 PowerShell로 `wsl --install` → 재부팅. 그다음 Claude가 Docker Desktop을 설치하고 #10을 확인한다. Docker 약관 동의는 주인이 한다.
4. 재부팅 자동 복구:
   - 작업 스케줄러 "로그온 시 `pm2 resurrect`": 허락하면 Claude가 등록한다.
   - 자동 로그인: 주인이 한다. 보안을 고려할 것.
   - 업데이트 자동 재시작 막기: 지금 사용 시간이 16~23시뿐이다. gpedit에서 "로그온한 사용자가 있으면 자동 다시 시작 안 함".
5. 버튼 결재 실제 확인: 두 번 클릭, 다른 계정 클릭, 오래된 버전 버튼.
6. 쓸 모델 정하기: `config.claude.model`(비우면 Opus, Pro 한도를 빨리 씀), `config.codex.model`.
7. #5 상태줄 % 와 claude.ai 사용량 화면 비교, #8 밤 재측정, #9 약관 최종 판단.
8. 나머지 직원 캐릭터 그림 (developer, reviewer, marketing, strategy, qa-local, git-cat, temp-1~4).
9. 화면 임시 초안(`point.extra.css`) 스크린샷 결재 → 결재되면 `design-systems/candidates.md`로.

### 주인 답을 기다리는 것
- **직원마다 Discord 봇** (보여 주기 전용, 7개):
  - 멤버 목록에 직원별로 뜨고, 상태에 "T-3 작업 중"이 보이며, 거울 메시지도 자기 봇 이름으로 올라간다.
  - 주인이 앱 7개를 만들고 토큰을 넣어야 한다. 아직 결정 전이다.
- PM 토큰 예상치 현실화(위 3장). 한도 자체는 바꾸지 않는다.

### 헤르메스 설치 뒤 Claude가 할 것
- 0단계 #1(도구 호출 5과제, `stage0/mock-mcp.mjs` 또는 실제 MCP)과 #7을 실행하고 `RESULTS.md`에 적는다.
- 헤르메스 gateway를 pm2(`ecosystem.config.cjs`)에 추가한다.
- 헤르메스 설치 뒤 #3 RAM을 한 번 더 측정한다.

### 알려진 사소한 것
- `C:\ai-office\repos\smoke-20261019015134`는 옮기기가 거부됐다(잠김). 해는 없다. 나중에 지운다.
- 0단계 smoke 출력 파일(`stage0\out\smoke-*-20261019.txt`)은 UTF-16이다.
