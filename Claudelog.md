# Claudelog: AI 사무실 인수인계

다른 AI(Claude, Codex)가 바로 이어서 일할 수 있게 압축한 현황이다. 마지막 갱신: **2026-10-20 (7-5 뒤 화면 개편·엔진 리팩터링·직원 봇·Opus 5.5까지)**.
저장소는 **공개**다(https://github.com/mightycha0826/LINDA_AI-OFFICE). 토큰, 비밀번호, Discord ID는 여기 적지 않는다(`C:\ai-office\data`에 있다).

## 0. 먼저 읽을 것
- `CLAUDE.md`: 작업 규칙. 설계와 다르면 먼저 묻는다. 안전 규칙은 테스트와 함께 만든다. 권한은 코드로만 집행한다. `design-systems/point/`는 읽기 전용이다.
- `docs/DESIGN.md`: 설계 기준(1~18장). 바꾼 결정은 해당 장에 날짜와 함께 메모로 남긴다.
- `docs/RUNNING.md`: 실행법.
- `docs/AUTONOMOUS-LOG.md`: 자율 진행 때 내린 결정. 맨 위에 최신 구간(76-A~I 화면·엔진, 75-A~H 7-5 보조 직원), 아래에 예전 결정 R~AS.
- `stage0/RESULTS.md`: 실제 환경 검증 결과.
- 주인 선호: **항상 한국어로 답한다.** **안전 한도(티켓 토큰 상한 = PM 예상치×2·최소 2만, 턴 40)는 설계대로 두고 바꾸자고 하지 않는다.** 푸시는 매번 주인 승인을 받는다.

## 1. 무엇인가
주인(CEO) 혼자 Discord로 지시하면, AI 직원들이 계획 → CEO 결재 → 개발(git worktree) → 교차 검토 → Git 고양이 푸시까지 하는 "AI 회사"다. 1~6단계 코드는 완성됐고, 지금은 **실제 운영 연결 단계**다.

| 구성 | 정체 | 두뇌 |
| --- | --- | --- |
| 오케스트레이터 | `packages/orchestrator`. 유일한 DB 쓰기 주체. 전환표·결재·한도·가드를 코드로 집행 | 없음 |
| LINDA (회사 시스템 봇) | 오케스트레이터 안의 discord.js. 결재 버튼, 알림, 슬래시 명령, #사무실-대화 거울(웹훅). **Message Content 인텐트 꺼 둠** | 없음 |
| 백서진 (비서실장 봇) | 헤르메스 에이전트 게이트웨이. #비서실 대화로 지시 등록과 상태 안내. 회사 MCP 도구 8개 사용 | **Gemma 4 12B** |
| 기획실장(PM), 개발팀장 | 오케스트레이터가 호출 | Claude Code `claude -p` Opus 5.5 (주인 Pro, 개인 설정 분리). 기획실장=리서치 몫, 개발팀장=개발 몫 |
| 개발자 A·B | 〃 | Codex `exec` (쓰기는 자기 티켓 worktree만, 회사 전용 CODEX_HOME) |
| 리뷰어·감사관, 카피라이터, 전략가 | 〃 | Codex `exec` |
| 교정 담당, 보조 직원 7명 | 〃 | Ollama `gemma4:12b-64k` (`LOCAL_MODEL`) |
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
- **테스트**: `npm test` 563개(통과 560, 건너뜀 2. Windows 기준. 나머지 1개 `workspace.test.ts`는 Windows 경로 테스트라 리눅스에서만 실패한다), typecheck·lint:ds 깨끗하다.
- **GitHub**: `6dd991f`까지 푸시했다(주인 승인, gitleaks 통과). 10-21에 작업 브랜치 `claude/loving-dirac-jwm9rq`를 main에 병합했다(주인 지시).
- **캐릭터**: chief-of-staff, pm은 진짜 그림(옆모습과 정면). 나머지는 단색 임시 그림.

### 0단계 결과
#2 모델 교체 통과(4~7초), #3 RAM 통과(최소 39GB 여유), #4·#5·#6 통과, #8 통과(낮), #9 조사 요약(최종 판단은 주인).
**#1 통과(재시험 뒤 5개 모두), #7 통과(10-19).** 과제 4(지시 등록)는 헤르메스가 Discord 메시지 ID를 모델에게 보여 주지 않아 실패했다. → LINDA가 #비서실 주인 마지막 메시지 ID를 기록하고 `create_order`가 ID 없이 오면 그것을 쓰게 함(주인 선택 A). 20:15 재시험에서 지시 `O-1`이 실제 메시지 ID로 등록됐다. PM 계획은 프로젝트 미등록·같은 모델 검토자 규칙에 걸려 멈춤(정상, `/프로젝트` 등록 뒤 다시 시도).
#10 SearXNG는 보류: WSL이 없어 관리자 승인과 재부팅이 필요하다.

## 4. 10-19~20 내린 결정과 이유 (위가 최신)
| 결정 | 이유 | 기록 |
| --- | --- | --- |
| 화면: 프로젝트 칩·캐릭터 목록·업무 탭 프로젝트별 보기 (CEO 요청 10-22) | ① 이름표 오른쪽에 지금 맡은 티켓의 프로젝트 칩(3D·2D 이름표·직원 탭, 좁은 2D 지도에선 숨김). ② 3D 왼쪽 캐릭터 목록(정규 → Git 고양이 → 보조 → 방문), 누르면 그 캐릭터 앞쪽 위로 가까이(맞은편 모니터 너머·조명 아래, 목록 옆 빈자리에 보이게 옆으로 비킴, 고양이는 위에서). PC는 펴서 시작·기억, 폰은 접혀서 시작·고르면 접힘. ③ 업무 탭 [프로젝트별][상태별](기본 프로젝트별, 기억): 프로젝트 → 지시(번호·원문 앞부분) → 티켓, 막힘 있는 프로젝트가 위, 프로젝트 없음은 끝. 스냅샷 티켓에 orderId·projectId, 스냅샷에 projects·orders. toScreenTicket는 인자 하나 그대로(staff-bots가 map으로 씀), 프로젝트는 withProject로 덧붙임 | DESIGN 12장, shared/screen.ts, screen/snapshot.ts, office-ui projects.ts·staff.ts·Office3DView·WorkTab·StaffTab·OfficeMap·scene.ts·layout.ts, projects.test.ts, test/org-screen.test.ts |
| 기능 점검 결함 2개 고침 (CEO 지시 10-21) | 두뇌는 프롬프트만 읽는데, 입력에 넣은 값이 프롬프트에 실리지 않았다. ① 관문: 직원별 모델 표(`staffModels`, 7-1)가 빠져 계획서 첫 판이 "모델을 알 수 없다"며 매번 반려됨(P-4·6·8·10) → 기획 몫 낭비·티켓 제목에 모델 주석. ② 검토: 교정 1차 점검(`proofread`, 7-4)이 빠져 검토자가 못 봄(DESIGN 16장 7-4 위반). 모델 표는 회사 집계라 그대로, 교정 결과는 `<data>`로 감쌈. 테스트는 이제 입력이 아니라 프롬프트를 검사(옛 코드에서 실패 확인). 같은 점검에서 찾은 나머지(티켓 선후 관계, 저장소 못 보는 글쓰기 티켓, 거울 정지, 완료 조건 글자 비교, Codex 캐시 토큰 집계)는 주인 결정 대기 | `staff/prompts.ts`, `test/org-7-1.test.ts`, `test/org-7-4.test.ts` |
| 비서실장 두뇌 Qwen3-14B → **Gemma 4 12B** (CEO 승인) | 헤르메스는 문맥 64K 미만을 거부한다. Qwen은 40,960이 한계이고 CPU로 35% 밀린다. Gemma는 64K에서 100% GPU, 66 tok/s | DESIGN 2·6·16·18장, `seed.ts` |
| 헤르메스 모델을 `gemma4:12b-64k` 태그로, `SOUL.md` 한국어화 | 비서실장이 영어로 답하고 skills_list만 반복했다. Ollama `/v1`이 `ollama_num_ctx`를 무시해 4096으로 떠서 입력이 2,051토큰에서 잘렸다(`ollama ps`로 확인). `SOUL.md`도 기본 영어 문구였다 | DESIGN 6장, HERMES-SETUP |
| **조직 개편 7단계** (CEO 지시) | GPT 한도를 회사가 전부 쓰기로(100%/100%), Claude는 그대로. Claude=판단(기획실장·개발팀장), GPT=양(개발자 A·B, 리뷰어·감사관, 전략가, 카피라이터), Gemma=보조 10명. 부서·팀장 구조 | DESIGN 2-0 조직도, 16장 7-1~7-5 |
| 7-5: 로컬 보조 직원 7명 (주인 부재 중, AUTONOMOUS-LOG 75-A~H) | 막힘 해설가·변경 요약가·거울 통역사·커밋 서기·회고 서기·보고 초안가·초안 작가, 역할 `assistant`(직원 표 다시 만들기 0008, 마이그레이션 동안만 외래 키 끔), GPU 순위(급함·보통·뒤), 화면 부서 배치. 보조 직원은 검토 불가, 초안 작가만 writing·marketing 티켓 | DESIGN 16장 7-5, `staff/assistants.ts`, `test/org-7-5.test.ts` |
| 7단계 진짜 두뇌 확인 (주인 부재 중) | `smoke --flow`(개발자 A 구현 → 개발팀장 검토, done)와 `smoke --doc`(카피라이터 → 교정 1차 점검 → 기획실장 검토, done) 통과. 문서 티켓이 토큰 상한에 걸려 기획실장 역할 카드에 문서 티켓 토큰 기준 추가 | stage0/RESULTS.md 맨 아래, `sim/smoke.ts` |
| 3D 캐릭터 9명 (CEO 결정 10-21: 코드 임시본 + VRM 자리) | 기준 = Discord 봇 프로필. 증명사진 세 장이 이름과 어긋나 있어 바로잡음(dev-b↔strategy 교환, 류하영은 pm.webp로, 한주아·설아인·서지우는 봇 프로필에서). 코드 인형: 외모 표(`characters.ts`) → 애니 얼굴 캔버스·턱선, 머리 모양 6종(긴 생머리·웨이브·단발·레이어드·묶음·땋은 단발)·앞머리 5종, 안경·리본·넥타이, 검은 정장(보조 직원은 색 가디건), 툰 셰이딩. VRM: `assets/models/<ID>.vrm`이 있으면 스냅샷 `model` → three-vrm 3.5.5로 앉히기(뼈 방향 맞추기)·타이핑·손짓·눈 깜빡임·스프링 본, 실패하면 코드 인형. CSP에 blob:(이미지·연결만). 시험 VRM(뼈 상자)으로 앉은 자세 확인, 진짜 VRoid 모델로는 아직 안 봄 | DESIGN 12·13장, `office3d/characters.ts`·`figure.ts`·`vrm.ts`, `docs/VROID-GUIDE.md`, `test/portraits.test.ts`, `characters.test.ts` |
| 직원 캐릭터 "살아 있는 것처럼" (CEO 요청 10-21) | 9명 봇에 살아온 이야기·말버릇·좋고 싫은 것·동료 관계·상황별 기분·예시 대사, 코드가 시각·상태로 기분 고름, 같은 채널 30분·4번 대화 기억(메모리만). 개인 이름 류하영(기획실장)·설아인(개발팀장)·서지우(카피라이터) 추가. 백서진은 HERMES-SETUP 3장 글을 주인이 SOUL.md에 붙여 넣어야 함 | DESIGN 9장, `staff/chat-personas.ts`, `discord/staff-chat.ts`, `test/staff-chat.test.ts`, HERMES-SETUP 3장 |
| 3D 사무실 적용 (CEO 지시 10-21) | 시안 ②를 실제 화면에 넣음. [3D][2D] 전환(PC 3D·폰 2D 기본, WebGL 없으면 2D). 자리 계산(`office3d/layout.ts`, 테스트)과 그림(`scene.ts`, three r149) 분리, three.js는 3D를 열 때만 불러옴. 회의 → 회의실, 파견 → 파견 라운지, 임시 → 커피 바, 결재 서류 수·회의실 표지·도킹 표시등·Git 고양이가 스냅샷을 따름. 이름표 클릭 → 카메라 이동 + 직원 상세. 3D 재질 색은 DS 예외 | DESIGN 12·17장, `office-ui/src/office3d/`, `components/Office3DView.tsx` |
| 파견 직원: 빌려 온 친구 계정 (CEO 결정 10-21, 한도 70%) | 계정 하나 = 파견 직원. add-guest.ps1로 친구가 직접 로그인(`data/guests/<ID>`, CLAUDE_CONFIG_DIR/CODEX_HOME), `/파견` [출근][퇴근](CEO만). 친구 계정 사용률 70%(Claude 실제·Codex 추정)에서 멈춤, usage 표·회사 계정 표시와 분리, 검토는 안 함, 퇴근·명단 제거 시 티켓 paused(budget). protect-secrets가 guests 폴더째 막음 | DESIGN 8장, `core/guests.ts`, `brains/registry.ts`, `engine/brain-calls.ts`, `test/guests.test.ts`, RUNNING 4장 |
| 직원 직접 지시·진행 중 수정 (CEO 결정 10-21) | 멘션 → Gemma가 intent(chat·order·revise) 제안 → LINDA가 주인 메시지 바로 아래에 [맡기고 시작]/[수정 반영] 버튼(CEO만·한 번·30분). 시작하면 담당 고정 계획서 한 장을 코드가 만들고 즉시 승인(관문 생략, 검토자는 코드가 다른 모델로), 대화·상태는 스레드 없이 그 채널에 받는 직원 태그로. 수정은 완료 조건 한 줄 + 검토 중이면 `ceo.revise`→rework. coding은 프로젝트 #작업 채널만, Git 고양이는 안 맡음. events 표 CHECK를 피하려 새 이벤트 종류는 만들지 않음 | DESIGN 5·9장, `core/direct.ts`, `discord/staff-chat.ts`·`mirror.ts`·`interactions.ts`, `test/direct.test.ts` |
| 캐릭터 이름·기준 그림 (CEO 지정 10-21) | 한주아=개발자 A, 한서윤=개발자 B, 서예린=전략가, 백예원=교정 담당, 차은설=리뷰어 · 감사관. 직함은 그대로, 이름은 화면 이름표·직원 탭·상세와 대화 자기소개에만. 정면 그림은 `assets/portraits/<ID>.webp`(직원 상세 증명사진, 시트는 아직) | DESIGN 13장 머리, `staff/org.ts` PERSONAL_NAMES, `test/org-screen.test.ts` |
| 직원 봇 대화 캐릭터 (CEO 요청 10-21) | 9개 봇이 같은 업무 카드라 말투가 비슷했다(개발팀장·개발자 A·B는 카드까지 같음). 봇마다 자기소개·말투·성격을 대화에만 붙임. 초안은 Claude 작성, 주인 검토 대기 | DESIGN 9장, `staff/chat-personas.ts`, `test/staff-chat.test.ts` |
| 직원 봇 주인 멘션 대답 (CEO 결정 10-20, 선택은 모두 추천안) | 주인이 아무 채널에서 직원 봇을 멘션하면 그 직원 이름으로 답글. 두뇌는 누구든 로컬 Gemma(한도 안 씀), 대화·상태 안내만(지시·결재·푸시 길 없음). 인텐트 Guilds·GuildMessages, Message Content는 여전히 끔(멘션한 글은 내용이 온다). 정지 중엔 AI 안 부름, 직원당 한 번에 한 질문. 초대 권한에 Send Messages 추가 | DESIGN 9장, `discord/staff-chat.ts`, `engine.chatAs`, `test/staff-chat.test.ts`, RUNNING 4장 |
| Claude 두뇌 Opus 5.5 · 노력 medium (CEO 결정 10-20) | `config.claude.model`=`claude-opus-5-5`, `config.claude.effort`=`medium`, `claude -p --effort`. 실제 CLI 응답 확인 | DESIGN 8장, `brains/claude-code.ts`, `test/isolation.test.ts` |
| 직원 봇 9개 (CEO 결정 10-20, 보여 주기 전용) | 정규 직원 9명이 자기 봇으로 #사무실-대화 거울 글과 상태 글(`T-3 작업 중`). 인텐트 Guilds만, 처리기 없음, 실패하면 웹훅. 토큰은 주인이 `set-secrets.ps1 -WithStaffBots` | DESIGN 9장, `discord/staff-bots.ts`, `test/staff-bots.test.ts`, RUNNING 4장 |
| 화면을 2-0 조직도에 맞춤 + 엔진 리팩터링 (주인 부재 중, AUTONOMOUS-LOG 76-A~I) | 지도 30×20·부서별 방·인원, 팀장 별·보조 80%, 직원 탭, 자기 색 임시 그림, 기획 몫·GPT 몫 이름. 리뷰어 → 품질보증팀, Git 고양이 → 운영지원. engine.ts를 호출 계층·계획·티켓 단계로 분리(동작 그대로). 14:47 운영 반영 | DESIGN 12장, `office-ui/src/map.ts`, `staff/org.ts`, `src/engine/`, `test/org-screen.test.ts` |
| 증명사진 (CEO 요청 10-21) | 직원을 누르면 상세 맨 위에 증명사진(`assets/portraits/<직원 ID>.webp`, 없으면 빈 틀)과 개인 이름. 비서실장 = 백서진(CEO). 같은 날 한주아·한서윤·서예린·백예원·차은설 사진·이름도 여기로 합침(브랜치 병합, 지도 이름표·직원 탭에도 이름). 로그 탭에서 다른 탭으로 가면 화면이 멈추던 문제도 고침 | DESIGN 12·13장, `EmployeeSheet.tsx`, `http/screen-server.ts` portraitOf, `test/portraits.test.ts` |
| 비밀 파일 읽기 막기 (별도 세션, b3295f3) | Codex 샌드박스 계정(CodexSandboxOffline, 그룹 CodexSandboxUsers)이 secrets.json·`codex-home\auth.json`을 읽을 수 있음을 canary로 확인. 막기·되돌리기 스크립트 준비, Claude 데이터 폴더 거부 규칙. **주인이 `scripts\protect-secrets.ps1 -IncludeCodexAuth` 실행 필요**(아직 안 함) | DESIGN 7장 비밀 파일 읽기 |
| 7-4: 전략가·카피라이터를 GPT로, 교정 1차 점검 | GPT 직원도 웹 도구 없이 오케스트레이터가 SearXNG로 대신 검색(Codex --search는 읽기 명령+검색어로 비밀이 샐 길이 있어 안 씀). 문서 티켓은 검토 전에 교정 담당(Gemma)이 지적 목록(판정 아님), 실패해도 안 멈춤. 리서치 몫은 기획실장만. 10-20 00:37 pm2 재시작으로 운영 반영(비밀 파일 세션의 Claude 거부 규칙 b3295f3도 함께) | DESIGN 15·16장, `engine/ticket-work.ts` proofread, `test/org-7-4.test.ts` |
| 7-3 완료: GPT 개발자 A·B(Codex) | Codex 쓰기는 개발자의 티켓 작업이 정확히 그 티켓 worktree일 때만(`codexSandboxFor`), 네트워크 끔, `--add-dir`·샌드박스 끄기 옵션 없음. GPT 코드는 개발팀장(Claude), 개발팀장 코드는 리뷰어(GPT), 로컬은 코드 판정 안 함. Codex 동시 2. 진짜 Codex로 안 쓰기 성공·밖 쓰기 거부·인터넷 차단 확인 | DESIGN 7장 7-3, `brains/codex.ts`, `test/org-7-3.test.ts`, RESULTS 7-3 |
| 7-2 완료: 로컬 두뇌 gemma4:12b-64k 하나로 | 비교 실험(`sim/local-compare.ts`): 둘 다 형식 16/16, Gemma가 품질 같거나 낫고 약 2배 빠름. 마케팅·검토 담당·커밋 초안·임시 직원·디자인 조합·저정밀 대체를 Gemma로. 로컬끼리는 검토 못 해서 로컬 문서는 GPT가 검토(끊기면 검토 대기) | DESIGN 16장 7-2, `LOCAL_MODEL`, `test/org-7-2.test.ts` |
| 7-1 완료: GPT 100%, 기획실장(PM)=Claude(기획 몫=리서치 몫), 기획 몫 소진 시 대기, 관문에 직원 모델 표, 회고 초안=Gemma·확인=GPT | 다음은 7-2(로컬 두뇌 gemma4:12b-64k 통일) | `seed.ts`, `engine.ts`, `retro/service.ts`, `test/org-7-1.test.ts` |
| PM 두뇌 비교 실험 (→ 7-1에서 Claude로 결정) | 같은 지시(O-2)로 Qwen(운영 기록)과 Claude(`sim/plan-compare.ts`, 메모리 DB) 비교. Qwen: PM 8번 중 5번 규칙 위반, CEO 다시 시도 2번, 관문 3번 모두 반려 → 반대 의견, 13분. Claude: 위반 0, 관문 2번째 통과(1번째 반려는 관문이 직원 모델을 몰라서), 67초, Claude 리서치 몫 약 1.1%·GPT 4.7만 토큰. 결과 `C:\ai-office\wt\_experiment\claude-20261019125153\report.md` | 주인 결정: PM을 Claude로 바꿀지, 관문에 직원 모델 표를 넘길지 |
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

## 7. 다음 할 일 (순서대로, 2026-10-20 갱신)
1. **주인: 비밀 파일 막기** `powershell -ExecutionPolicy Bypass -File C:\ai-office\office\scripts\protect-secrets.ps1 -IncludeCodexAuth` 실행. 확인은 `packages\orchestrator`에서 `node src/sim/secrets-read-check.ts`. GPT 개발자가 쓰기 권한으로 일하기 전에 해야 한다.
2. **주인: 옛 지시 정리** O-1은 #막힘에서 [취소]. O-2는 [취소] 뒤 jhwchn 카테고리 #작업에서 새로 지시해 새 조직(Claude 기획실장 → GPT 개발자 → Claude 검토)으로 계획되게 한다.
3. **실제 첫 지시 관찰** (Claude): 계획서 결재 → 개발자 A·B → 검토 → Git 고양이 푸시 결재까지. 버튼 시험(두 번 클릭, 다른 계정, 오래된 버전)도 같이.
4. **주인 결정**: 토큰 상한에 걸린 그 호출의 결과를 기록할지(지금은 버림, 7장 안전 한도).
5. **재부팅 대비** (주인): 자동 로그인, 업데이트 자동 재시작 막기. pm2(`AI_Office_pm2`)·헤르메스(`Hermes_Gateway`) 작업은 등록됨.
6. **SearXNG(#10)**: 주인이 `wsl --install`과 재부팅 → Claude가 Docker·SearXNG 설치와 연결. 그전엔 GPT 직원 웹 근거가 비어 있다.
7. **정리**: Qwen 모델 지우기(`ollama rm qwen3:14b`, 주인 승인), 교정 담당이 대괄호 안 공백 같은 형식 실수를 놓친 것 보완.
8. **주인**: 직원 봇 9개 만들기(RUNNING 4장 "직원 봇 9개 만들기", 초대 권한에 Send Messages 포함, 토큰은 `set-secrets.ps1 -WithStaffBots`). 만든 뒤 `@직원 지금 뭐 해?`로 대답 확인.
9. 캐릭터 그림: 한주아·한서윤·서예린·백예원·차은설은 정면 그림(`assets/portraits/`)이 있으니 옆모습·정면 시트로(CHARACTER-PROMPTS), 나머지(개발팀장·카피라이터·Git 고양이·보조 직원 7명)는 그림부터. 그 밖에 화면 임시 초안(`point.extra.css`) 결재, #8 밤 재측정, 헤르메스를 켠 상태로 #3 RAM 재측정.

## 8. 커밋 흐름 (요약)
10-15~16: 1~6단계(`d569abd`…`4a612ff`) → 10-16~17: 0단계 실측·개인 설정 분리(`4f0a435`…`0bbab50`) → 10-18~19: 캐릭터(`9baf7e8`…`9f74556`) → 10-19: 비밀 값 스크립트, Codex 정리, #2·#3, worktree 버그, #9, `/지시`, 헤르메스 연결, Gemma 전환(`2bd0b70`…`368bda5`), pm2 자동 시작(`6eb2ef6`), 어댑터·엔진 리팩터링(`2ba8847`). 전체는 `git log --oneline`.
