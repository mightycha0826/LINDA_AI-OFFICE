# Claudelog: AI 사무실 인수인계

다른 AI(Claude, Codex)가 바로 이어서 일할 수 있게 압축한 현황이다. 마지막 갱신: **2026-10-19 19:45 KST**.
저장소는 **공개**다(https://github.com/mightycha0826/LINDA_AI-OFFICE). 토큰, 비밀번호, Discord ID는 여기 적지 않는다(`C:\ai-office\data`에 있다).

## 0. 먼저 읽을 것
- `CLAUDE.md`: 작업 규칙. 설계와 다르면 먼저 묻는다. 안전 규칙은 테스트와 함께 만든다. 권한은 코드로만 집행한다. `design-systems/point/`는 읽기 전용이다.
- `docs/DESIGN.md`: 설계 기준(1~18장). 바꾼 결정은 해당 장에 날짜와 함께 메모로 남긴다.
- `docs/RUNNING.md`: 실행법.
- `docs/AUTONOMOUS-LOG.md`: 자율 진행 때 내린 결정 R~AS.
- `stage0/RESULTS.md`: 실제 환경 검증 결과.
- 주인 선호: **항상 한국어로 답한다.** **안전 한도(티켓 토큰 상한 = PM 예상치×2·최소 2만, 턴 40)는 설계대로 두고 바꾸자고 하지 않는다.** 푸시는 매번 주인 승인을 받는다.

## 1. 무엇인가
주인(CEO) 혼자 Discord로 지시하면, AI 직원들이 계획 → CEO 결재 → 개발(git worktree) → 교차 검토 → Git 고양이 푸시까지 하는 "AI 회사"다. 1~6단계 코드는 완성됐고, 지금은 **실제 운영 연결 단계**다.

| 구성 | 정체 | 두뇌 |
| --- | --- | --- |
| 오케스트레이터 | `packages/orchestrator`. 유일한 DB 쓰기 주체. 전환표·결재·한도·가드를 코드로 집행 | 없음 |
| LINDA (회사 시스템 봇) | 오케스트레이터 안의 discord.js. 결재 버튼, 알림, 슬래시 명령, #사무실-대화 거울(웹훅). **Message Content 인텐트 꺼 둠** | 없음 |
| 백서진 (비서실장 봇) | 헤르메스 에이전트 게이트웨이. #비서실 대화로 지시 등록과 상태 안내. 회사 MCP 도구 8개 사용 | **Gemma 4 12B** |
| PM, 마케팅 | 오케스트레이터가 호출 | Ollama qwen3:14b |
| 검토 담당 | 〃 | Ollama gemma4:12b |
| 개발자 | 〃 | Claude Code `claude -p` (주인 Pro, 개인 설정 분리) |
| 리뷰어·감사관 | 〃 | Codex `exec` 읽기 전용 (회사 전용 CODEX_HOME) |
| 경영전략·리서치 | 〃 | Claude |
| Git 고양이 | 오케스트레이터 모듈 | 코드 |
| 사무실 화면 | `packages/office-ui` (React). http://127.0.0.1:8780 | — |

## 2. 위치
- 저장소: `C:\ai-office\office` (npm workspaces: `shared`, `orchestrator`, `office-ui`. Node 24는 .ts를 바로 실행한다)
- 운영 데이터: `C:\ai-office\data`
  - `config.json`: 채널·서버·CEO ID, `hermes.homeDir`
  - `secrets.json`: 봇 토큰, 웹훅, internalApiToken. **AI가 직접 쓰지 않는다**
  - `office.db`
  - `codex-home\`
- 작업 공간: `C:\ai-office\repos`(등록 프로젝트, 아직 없음), `C:\ai-office\wt`(티켓 worktree), `C:\ai-office\backups`
- 헤르메스: `C:\Users\Aranea\AppData\Local\hermes`
  - `config.yaml`, `.env`(봇 토큰)
  - `logs\agent.log`: 대화와 도구 호출 기록
  - `gateway.log`
- pm2: `C:\Users\Aranea\.pm2` (앱 `ai-office`, 로그 `logs\ai-office-out.log`)

## 3. 지금 상태
- **오케스트레이터**: pm2로 실행 중(19:44 `pm2 restart`로 리팩터링 반영, 데몬은 작업 스케줄러 `AI_Office_pm2`가 띄운 것). LINDA#9825 접속, 화면 :8780, 내부 API :8790.
- **Discord**: 비공개 서버와 채널 5개(#비서실, #결재함, #보고, #막힘, #사무실-대화). 슬래시 명령이 등록됐고 `/상태` 응답을 확인했다. `/지시` 명령을 추가했다(헤르메스 없이 직접 지시).
- **헤르메스(백서진)**: 설치·연결 완료. #비서실에서 답하는 것을 주인이 확인했다(Gemma, 한 번에 5~12초).
  - Blank Slate 설정이다. `agent.disabled_toolsets`에 terminal·file·vision을 추가했다.
  - `platform_toolsets.discord: [cronjob, memory, session_search, skills]`, MCP `office`(8 도구, tool_search로 지연 로딩).
  - `model.default: gemma4:12b`, `ollama_num_ctx: 65536`.
  - `.env`: 주인만 허용, #비서실이 홈이고 멘션 없이 답한다.
  - 게이트웨이는 작업 스케줄러 `Hermes_Gateway`로 로그인 때 켜진다.
- **로컬 모델**: Ollama 0.40.5, qwen3:14b·gemma4:12b. C: 여유 약 62GB. VRAM 12GB(RTX 3060).
- **테스트**: `npm test` 411개 통과, typecheck·lint:ds 깨끗하다.
- **GitHub**: `2ba8847`(10-19 리팩터링)까지 푸시했다(주인 승인, gitleaks 통과). 이 문서 갱신 커밋은 로컬에만 있다.
- **캐릭터**: chief-of-staff, pm은 진짜 그림(옆모습과 정면). 나머지는 단색 임시 그림.

### 0단계 결과
#2 모델 교체 통과(4~7초), #3 RAM 통과(최소 39GB 여유), #4·#5·#6 통과, #8 통과(낮), #9 조사 요약(최종 판단은 주인).
**#1 헤르메스 도구 호출 5과제와 #7 Discord는 주인이 시험 문장을 보내는 중이다.** 채점은 `agent.log`에서 `mcp__office__*` 호출을 본다(과제는 `stage0/CHECKLIST.md`).
#10 SearXNG는 보류: WSL이 없어 관리자 승인과 재부팅이 필요하다.

## 4. 오늘(10-19) 내린 결정과 이유
| 결정 | 이유 | 기록 |
| --- | --- | --- |
| 비서실장 두뇌 Qwen3-14B → **Gemma 4 12B** (CEO 승인) | 헤르메스는 문맥 64K 미만을 거부한다. Qwen은 40,960이 한계이고 CPU로 35% 밀린다. Gemma는 64K에서 100% GPU, 66 tok/s | DESIGN 2·6·16·18장, `seed.ts` |
| `/지시` 슬래시 명령 추가 (CEO 요청) | 헤르메스 없이도 지시할 수 있게. 상호작용 ID로 중복을 막는다 | DESIGN 9장 |
| 남은 worktree 폴더 재사용 금지 | 시험(`smoke --flow`)이 남긴 `wt\T-1`을 진짜 첫 티켓이 쓸 뻔했다. 같은 저장소·브랜치가 아니면 `stale-worktree`로 멈춘다 | `workspace/worktrees.ts` |
| Codex 회사 홈에서 기본 스킬·플러그인 끄기 | 입력 토큰이 75,764에서 42,290으로 줄었다 | `brains/codex.ts` |
| 토큰 상한은 그대로 | 실제 흐름에서 Claude 1회가 40~51k토큰(대부분 캐시)이라 작은 티켓이 첫 호출 뒤 `paused(cap)`된다. 주인은 설계 유지를 원한다(`/재개`로 이어감) | RESULTS.md |

## 5. 반드시 알아야 할 함정
- **pm2를 Claude 앱의 터미널 탭에서 띄우면, 앱이 재시작될 때 같이 죽는다.** 10-19 16:25~19:18 사무실이 꺼져 있었다.
  - 해결(주인 승인): 작업 스케줄러 `AI_Office_pm2`(로그온 30초 뒤 `scripts/pm2-resurrect.vbs` → `pm2 resurrect`, 기록 `C:\ai-office\data\pm2-autostart.log`)를 등록했고, 지금 pm2 데몬도 이 작업으로 띄웠다.
  - **터미널 탭에서 `pm2 kill`이나 새 데몬을 만들지 않는다.** 데몬이 없으면 `Start-ScheduledTask AI_Office_pm2`로 띄운다. `pm2 restart ai-office`, `pm2 save`는 괜찮다.
  - 등록 스크립트: `scripts/register-pm2-autostart.ps1 [-StartNow]`
- Claude Code의 Bash/PowerShell은 샌드박스다. 실제 셸 작업은 Terminal 패널(`run_in_terminal`)에서 한다. 패널 명령에는 파이프와 변수를 쓸 수 없다.
- **헤르메스 실행 파일은 Claude의 터미널에서 '액세스 거부'된다.** `hermes gateway restart`는 주인이 자기 PowerShell에서 한다. 설정 파일 읽기와 쓰기는 Claude도 된다(실제 파일에 반영됨을 확인했다).
- 헤르메스 `config.yaml`을 고친 뒤에는 게이트웨이를 재시작해야 반영된다. MCP 추가만은 약 1분 뒤 자동 반영된다.
- Windows PowerShell 5.1:
  - 한글이 든 `.ps1`은 UTF-8 BOM이 필요하다.
  - JSON은 Node로 쓴다.
  - 리디렉션 출력은 UTF-16이다.
- `claude -p`는 세션 변수(`CLAUDE_*`, `ANTHROPIC_BASE_URL`)가 넘어가면 로그인이 깨진다. `safeEnv` 허용 목록으로 막는다.
- 개인 설정 분리: Claude는 `--setting-sources project,local --strict-mcp-config --disable-slash-commands`. Codex는 회사 CODEX_HOME. Codex 샌드박스가 `-C`를 무시해서 작업 폴더는 절대 경로로 알려 준다.
- 헤르메스 설치 스크립트(`iex (irm …)`)는 자동 모드에서 막힌다. 주인이 실행한다.
- 헤드리스 Edge 스크린샷은 캐릭터가 그려지기 전에 찍히곤 한다. 미리보기 PNG를 직접 합성하는 편이 확실하다.

## 6. 자주 쓰는 명령
```
npm test | npm run typecheck | npm run lint:ds | npm run build:screen
npm run smoke -- --config C:\ai-office\data\config.json [--only ollama|claude|codex] [--flow]
pm2 restart ai-office | pm2 resurrect | pm2 logs ai-office --lines 30 --nostream
gitleaks git --log-opts=origin/main..main ; git push origin main      # 주인 승인 후
python scripts/slice-sprite-sheet.py <시트> <id> --both                # 캐릭터 (docs/CHARACTER-PROMPTS.md)
powershell -ExecutionPolicy Bypass -File scripts\set-secrets.ps1       # 주인이 회사 봇 비밀 값
powershell -ExecutionPolicy Bypass -File scripts\hermes-configure.ps1  # 헤르메스 연결 (-NoToken 가능)
```
Discord 명령: `/지시`, `/보고`, `/상태 T-n`, `/push T-n`, `/되돌리기 T-n`, `/한도`, `/정지`, `/재개`, `/프로젝트`, `/설정`.

## 7. 다음 할 일 (순서대로)
1. **0단계 #1·#7 채점**: 주인이 #비서실에 `/new` 뒤 과제 5개를 보낸다. `agent.log`에서 도구 호출을 확인하고 `RESULTS.md`에 기록한다.
   - 과제 4는 실제 지시(소개 문구)가 등록된다. PM 계획서가 #결재함에 오는지까지 본다.
2. **재부팅 대비**: pm2 로그온 작업은 등록 완료(`AI_Office_pm2`). 헤르메스도 자체 작업(`Hermes_Gateway`)이 있다. 주인 몫: 자동 로그인, 업데이트 자동 재시작 막기(지금 사용 시간이 16~23시뿐이다).
3. 이 문서 갱신 커밋을 푸시한다(주인 승인 후). `2ba8847`까지는 끝났다.
4. `/프로젝트`로 GitHub 저장소를 등록한다(코딩 지시 전 필수).
5. 버튼 결재를 실제로 시험한다: 두 번 클릭, 다른 계정, 오래된 버전.
6. WSL → Docker → SearXNG(#10). 주인이 `wsl --install`과 재부팅을 한다.
7. 주인 결정 대기:
   - 직원별 Discord 봇(보여 주기 전용 7개)
   - PM 토큰 예상치 현실화(한도 자체는 유지)
   - `config.claude.model`(비우면 Opus)
   - 사무실 화면 비서실장 이름을 "백서진"으로 할지
8. 나머지 캐릭터 그림. 화면 임시 초안(`point.extra.css`) 결재. #8 밤 재측정. 헤르메스를 켠 상태로 #3 RAM 재측정.

## 8. 커밋 흐름 (요약)
10-15~16: 1~6단계(`d569abd`…`4a612ff`) → 10-16~17: 0단계 실측·개인 설정 분리(`4f0a435`…`0bbab50`) → 10-18~19: 캐릭터(`9baf7e8`…`9f74556`) → 10-19: 비밀 값 스크립트, Codex 정리, #2·#3, worktree 버그, #9, `/지시`, 헤르메스 연결, Gemma 전환(`2bd0b70`…`368bda5`), pm2 자동 시작(`6eb2ef6`), 어댑터·엔진 리팩터링(`2ba8847`). 전체는 `git log --oneline`.
