# Claudelog: AI 사무실 인수인계

다른 AI(Claude, Codex)가 바로 이어서 일할 수 있게 압축한 현황이다. 마지막 갱신: **2026-10-19 23:00 KST**.
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
- **오케스트레이터**: pm2로 실행 중(20:11 `pm2 restart`로 메시지 ID 기록 반영, 데몬은 작업 스케줄러 `AI_Office_pm2`가 띄운 것). LINDA#9825 접속, 화면 :8780, 내부 API :8790.
- **Discord**: 비공개 서버와 채널 5개(#비서실, #결재함, #보고, #막힘, #사무실-대화). 슬래시 명령이 등록됐고 `/상태` 응답을 확인했다. `/지시` 명령을 추가했다(헤르메스 없이 직접 지시).
- **헤르메스(백서진)**: 설치·연결 완료. #비서실에서 답하는 것을 주인이 확인했다(Gemma, 한 번에 5~12초).
  - Blank Slate 설정이다. `agent.disabled_toolsets`에 terminal·file·vision을 추가했다.
  - `platform_toolsets.discord: [cronjob, memory, session_search, skills]`, MCP `office`(8 도구, tool_search로 지연 로딩).
  - `model.default: gemma4:12b-64k`(num_ctx 65536을 박은 태그), `ollama_num_ctx: 65536`. `SOUL.md`는 한국어 비서실장 지침(백업 `SOUL.md.bak-20261019-2000`).
  - 주인이 `hermes gateway restart`로 64K·SOUL.md를 반영했다(19:58). 20:11에 SOUL.md의 지시 등록 줄을 "discordMessageId는 넣지 않는다"로 바꿨고, 주인이 재시작과 `/new`로 반영했다.
  - `.env`: 주인만 허용, #비서실이 홈이고 멘션 없이 답한다.
  - 게이트웨이는 작업 스케줄러 `Hermes_Gateway`로 로그인 때 켜진다.
- **로컬 모델**: Ollama 0.40.5. 7-2부터 로컬 두뇌는 `gemma4:12b-64k` 하나(헤르메스·오케스트레이터 공용, num_ctx 65536). qwen3:14b·gemma4:12b 파일은 아직 디스크에 있음(지울지는 주인 결정). C: 여유 약 62GB. VRAM 12GB(RTX 3060).
- **테스트**: `npm test` 472개 중 471개 통과 (1개는 비밀 파일 권한 세션의 진행 중 변경 때문), typecheck·lint:ds 깨끗하다.
- **GitHub**: `6dd991f`까지 푸시했다(주인 승인, gitleaks 통과). 그 뒤 커밋(64K 원인, 0단계 결과, 메시지 ID 기록)은 로컬에만 있다.
- **캐릭터**: chief-of-staff, pm은 진짜 그림(옆모습과 정면). 나머지는 단색 임시 그림.

### 0단계 결과
#2 모델 교체 통과(4~7초), #3 RAM 통과(최소 39GB 여유), #4·#5·#6 통과, #8 통과(낮), #9 조사 요약(최종 판단은 주인).
**#1 통과(재시험 뒤 5개 모두), #7 통과(10-19).** 과제 4(지시 등록)는 헤르메스가 Discord 메시지 ID를 모델에게 보여 주지 않아 실패했다. → LINDA가 #비서실 주인 마지막 메시지 ID를 기록하고 `create_order`가 ID 없이 오면 그것을 쓰게 함(주인 선택 A). 20:15 재시험에서 지시 `O-1`이 실제 메시지 ID로 등록됐다. PM 계획은 프로젝트 미등록·같은 모델 검토자 규칙에 걸려 멈춤(정상, `/프로젝트` 등록 뒤 다시 시도).
#10 SearXNG는 보류: WSL이 없어 관리자 승인과 재부팅이 필요하다.

## 4. 오늘(10-19) 내린 결정과 이유
| 결정 | 이유 | 기록 |
| --- | --- | --- |
| 비서실장 두뇌 Qwen3-14B → **Gemma 4 12B** (CEO 승인) | 헤르메스는 문맥 64K 미만을 거부한다. Qwen은 40,960이 한계이고 CPU로 35% 밀린다. Gemma는 64K에서 100% GPU, 66 tok/s | DESIGN 2·6·16·18장, `seed.ts` |
| 헤르메스 모델을 `gemma4:12b-64k` 태그로, `SOUL.md` 한국어화 | 비서실장이 영어로 답하고 skills_list만 반복했다. Ollama `/v1`이 `ollama_num_ctx`를 무시해 4096으로 떠서 입력이 2,051토큰에서 잘렸다(`ollama ps`로 확인). `SOUL.md`도 기본 영어 문구였다 | DESIGN 6장, HERMES-SETUP |
| **조직 개편 7단계** (CEO 지시) | GPT 한도를 회사가 전부 쓰기로(100%/100%), Claude는 그대로. Claude=판단(기획실장·개발팀장), GPT=양(개발자 A·B, 리뷰어·감사관, 전략가, 카피라이터), Gemma=보조 10명. 부서·팀장 구조 | DESIGN 2-0 조직도, 16장 7-1~7-5 |
| 7-4: 전략가·카피라이터를 GPT로, 교정 1차 점검 | GPT 직원도 웹 도구 없이 오케스트레이터가 SearXNG로 대신 검색(Codex --search는 읽기 명령+검색어로 비밀이 샐 길이 있어 안 씀). 문서 티켓은 검토 전에 교정 담당(Gemma)이 지적 목록(판정 아님), 실패해도 안 멈춤. 리서치 몫은 기획실장만. **커밋만 했고 운영 재시작은 비밀 파일 세션이 끝난 뒤** | DESIGN 15·16장, `engine.ts` proofread, `test/org-7-4.test.ts` |
| 7-3 완료: GPT 개발자 A·B(Codex) | Codex 쓰기는 개발자의 티켓 작업이 정확히 그 티켓 worktree일 때만(`codexSandboxFor`), 네트워크 끔, `--add-dir`·샌드박스 끄기 옵션 없음. GPT 코드는 개발팀장(Claude), 개발팀장 코드는 리뷰어(GPT), 로컬은 코드 판정 안 함. Codex 동시 2. 진짜 Codex로 안 쓰기 성공·밖 쓰기 거부·인터넷 차단 확인 | DESIGN 7장 7-3, `brains/codex.ts`, `test/org-7-3.test.ts`, RESULTS 7-3 |
| 7-2 완료: 로컬 두뇌 gemma4:12b-64k 하나로 | 비교 실험(`sim/local-compare.ts`): 둘 다 형식 16/16, Gemma가 품질 같거나 낫고 약 2배 빠름. 마케팅·검토 담당·커밋 초안·임시 직원·디자인 조합·저정밀 대체를 Gemma로. 로컬끼리는 검토 못 해서 로컬 문서는 GPT가 검토(끊기면 검토 대기) | DESIGN 16장 7-2, `LOCAL_MODEL`, `test/org-7-2.test.ts` |
| 7-1 완료: GPT 100%, 기획실장(PM)=Claude(기획 몫=리서치 몫), 기획 몫 소진 시 대기, 관문에 직원 모델 표, 회고 초안=Gemma·확인=GPT | 다음은 7-2(로컬 두뇌 gemma4:12b-64k 통일) | `seed.ts`, `engine.ts`, `retro/service.ts`, `test/org-7-1.test.ts` |
| PM 두뇌 비교 실험 (→ 7-1에서 Claude로 결정) | 같은 지시(O-2)로 Qwen(운영 기록)과 Claude(`sim/plan-compare.ts`, 메모리 DB) 비교. Qwen: PM 8번 중 5번 규칙 위반, CEO 다시 시도 2번, 관문 3번 모두 반려 → 반대 의견, 13분. Claude: 위반 0, 관문 2번째 통과(1번째 반려는 관문이 직원 모델을 몰라서), 67초, Claude 리서치 몫 약 1.1%·GPT 4.7만 토큰. 결과 `C:ai-officewt_experimentclaude-20261019125153eport.md` | 주인 결정: PM을 Claude로 바꿀지, 관문에 직원 모델 표를 넘길지 |
| 검토자 짝은 코드가 고침 (CEO 승인) | 표·후보 안내를 줘도 PM(Qwen)이 계획서 6번 중 4번 같은 모델 검토자를 골랐다. 같은 모델·본인·비서실장이면 코딩→reviewer, 그 밖→qa-local로 바꾸고 `plans.reviewer_changes`에 남겨 결재 메시지에 표시. 비서실장은 검토자 후보에서 뺌. 실제 첫 GPT 관문(21:25)은 정상 동작, "확인할 수 없는 완료 조건·불필요한 백엔드"를 정확히 지적 | DESIGN 6·9장, `core/plans.ts` fixReviewers, 마이그레이션 0007 |
| 계획 작성 멈춤을 #막힘에 [다시 시도][취소]로 알림, PM 검토자 표 | O-2(포트폴리오)가 PM의 같은 모델 검토자 실수로 멈췄는데 **알림도 다시 시도할 길도 없었다**(retryPlanning을 부르는 곳이 없었음). 멈춘 시각으로 구분해 한 번씩 알리고, PM 역할 카드에 담당자별 검토 가능 직원 표, 위반 안내에 후보를 적음 | DESIGN 6·9장 ④-2, `discord/notifier.ts`, `staff/role-cards.ts` |
| `/새프로젝트`: GitHub 비공개 저장소 + Discord 카테고리 `아이디` › `#작업` (CEO 요청, 선택은 모두 추천안) | 저장소를 따로 만들고 `/프로젝트`로 등록하는 게 번거로움. 토큰을 모든 저장소(Administration·Contents 쓰기)로 넓히고 고양이는 DB 등록 저장소에만 푸시. `#작업`의 `/지시`는 그 프로젝트로 고정, PM은 그 프로젝트만 보고 비우면 코드가 채움. 비서실장은 #비서실에만 | DESIGN 6·9·11장, `workspace/new-project.ts`, `gitcat/github-repo.ts`, 마이그레이션 0006 |
| `create_order` 메시지 ID를 코드가 채움 (CEO 선택 A) | 헤르메스가 모델에게 ID를 안 보여 줘서 모델이 `current_message_id`를 지어냈다. LINDA가 #비서실 주인 마지막 메시지 ID·시각만 기록(내용 안 받음), 10분 넘으면 거부, 같은 ID는 지시 하나 | DESIGN 6·9장, `chief/order-message.ts` |
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
- **Ollama `/v1`(OpenAI 호환)은 요청의 `num_ctx`를 무시한다.** 헤르메스처럼 `/v1`로 붙는 쪽은 Modelfile로 num_ctx를 박은 태그를 써야 한다. 확인은 `ollama ps`의 CONTEXT. `config.yaml`은 게이트웨이가 잡고 있어 `sed -i`가 실패한다(Node로 제자리 쓰기).
- 헤르메스 `config.yaml`을 고친 뒤에는 게이트웨이를 재시작해야 반영된다.
- **헤르메스는 대화를 시작할 때의 지침(SOUL.md)을 그 대화 끝까지 쓴다.** SOUL.md를 바꾸면 재시작 뒤 #비서실에서 `/new`(또는 `/reset`)까지 해야 한다. 안 하면 예전 답을 되풀이한다(10-19 20:13). MCP 추가만은 약 1분 뒤 자동 반영된다.
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
4. 주인: GitHub 토큰을 모든 저장소(Administration·Contents 쓰기)로 다시 만들어 `set-secrets.ps1 -WithGithub`로 넣고, LINDA에 채널 관리 권한을 준다. 그다음 `/새프로젝트 아이디`로 첫 프로젝트를 만든다(이미 있는 저장소는 `/프로젝트`). O-1은 프로젝트가 없어 계획이 멈춰 있다(취소하거나 다시 시도).
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
