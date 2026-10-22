# 실행 안내

AI 사무실을 설치하고 켜는 순서. 설계는 `docs/DESIGN.md`, 주인이 없는 동안 정한 것은 `docs/AUTONOMOUS-LOG.md`.

## 1. 준비

- Windows, Node 24 이상(LTS), git 2.44 이상
- 0단계 검증(`stage0/CHECKLIST.md`)을 먼저 끝낸다. 결과는 `stage0/RESULTS.md`
- Ollama의 로컬 두뇌는 `gemma4:12b-64k` 하나다(7-2). `ollama pull gemma4:12b` 뒤 num_ctx 65536 태그를 만든다(`docs/HERMES-SETUP.md`). Claude Code(`claude`), Codex(`codex`)가 설치·로그인되어 있어야 한다
- SearXNG(Docker, 127.0.0.1:8888)와 gitleaks 8.19 이상

```bash
npm install
```

## 2. 확인 (API 비용 0)

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run sim
```

`npm run sim`은 MockLLM으로 지시 → 계획 → 티켓 → 검토 → 회의 → 결재 → 회고까지 한 번 돈다.

## 3. 사무실 화면 미리보기

```bash
npm run build:screen
```

```bash
npm run demo:screen
```

http://127.0.0.1:8780 을 연다. 메모리 DB와 MockLLM으로 직원들이 천천히 일한다(결재는 6초 뒤 자동 "승인" — 미리보기에만 있다).
화면을 고치는 중이면 `npm -w @ai-office/office-ui run dev`(http://localhost:5173)를 같이 켠다.

## 4. 설정 파일 (저장소 밖)

`C:\ai-office\data\` 아래에 둔다.

- `config.json`: `docs/config.example.json`을 복사해서 고친다. 반드시 바꿀 것:
  - `ceoDiscordId`: 주인 Discord 사용자 ID (이 계정의 클릭만 결재로 인정한다)
  - `discord.guildId`, `discord.channels`(#비서실, #결재함, #보고, #막힘, #사무실-대화의 채널 ID)
  - 폰에서 화면을 보려면 `screen.hosts`와 `screen.allowedHostnames`에 Tailscale 주소·이름
  - `hermes.homeDir`: 헤르메스 데이터 폴더 (비우면 백업하지 않는다)
- `secrets.json`: `discordToken`, `mirrorWebhookUrl`, `githubToken`, `staffBotTokens`(직원 봇, 아래), `internalApiToken`(처음 켤 때 자동으로 만든다).
  - `githubToken`: 세분화된 토큰(fine-grained). `/새프로젝트`로 저장소를 자동으로 만들려면 **Repository access: All repositories**, 권한 **Administration: Read and write**, **Contents: Read and write**(Metadata는 자동). 회사는 DB에 등록된 저장소에만 푸시한다(DESIGN 11장, 2026-10-19 변경).
  - `/새프로젝트`의 카테고리·채널 생성은 비서실장 백서진이 담당한다. Hermes의 봇 인증을 사용하며 LINDA에는 **채널 관리** 권한이 필요 없다. 역할 순서와 최소 권한은 [DISCORD-AUTHORITY.md](DISCORD-AUTHORITY.md)를 따른다.
  - 값은 손으로 붙여 넣지 말고 `powershell -ExecutionPolicy Bypass -File scripts\set-secrets.ps1`로 넣는다(입력이 화면에 안 보이고, 형식을 검사하고, BOM 없는 UTF-8로 저장). GitHub 토큰까지 넣으려면 `-WithGithub`.

설정 검사에 실패하면 무엇이 틀렸는지 알려 주고 켜지지 않는다.

### 직원 봇 9개 만들기 (DESIGN 9장)

정규 직원 9명(기획실장, 개발팀장, 개발자 A, 개발자 B, 리뷰어 · 감사관, 카피라이터, 전략가, 교정 담당, Git 고양이)이 #사무실-대화에 자기 계정으로 글을 올리고, 멤버 목록에 `T-3 작업 중` 같은 상태를 띄운다. 주인이 아무 채널에서나 `@류하영 지금 뭐 해?`(기획실장 봇)처럼 멘션하면 그 봇이 답글로 대답한다(로컬 Gemma). `@한주아 로그인 화면에 비밀번호 찾기 링크 넣어줘`처럼 일을 맡기면 LINDA가 바로 아래에 [맡기고 시작] 버튼을 띄우고, 누르면 그 직원이 맡아 같은 채널에서 다른 직원을 태그하며 진행한다(코드 일은 프로젝트 #작업 채널에서). 진행 중인 일도 그 직원을 멘션해 고쳐 달라고 하면 [수정 반영] 버튼이 뜬다. 푸시 결재는 지금처럼 #결재함 버튼으로 한다. 토큰이 없는 직원은 지금처럼 웹훅 이름으로 보이니, 몇 명만 먼저 만들어도 된다.

직원마다 아래를 한 번씩 한다.

1. https://discord.com/developers/applications 에서 **New Application**을 누르고, 이름을 직원 이름(예: `기획실장`)으로 짓는다. 아이콘은 원하면 캐릭터 그림으로 바꾼다.
2. 왼쪽 **Bot** 메뉴에서:
   - **Public Bot**은 끈다.
   - **Privileged Gateway Intents** 세 개(Presence, Server Members, Message Content)는 모두 **꺼 둔다**. Message Content를 꺼도 그 봇을 멘션한 글의 내용은 받는다.
   - **Reset Token**을 눌러 토큰을 복사한다. 바로 4번에서 붙여 넣고, 채팅이나 메모장 같은 다른 곳에는 붙이지 않는다.
3. 왼쪽 **OAuth2 → URL Generator**에서:
   - Scopes는 `bot` 하나만 고른다.
   - Bot Permissions는 **View Channels**, **Send Messages**, **Send Messages in Threads**, **Read Message History** 네 개만 고른다. Administrator는 고르지 않는다. (Send Messages는 멘션에 답하려고 2026-10-20에 더했다. 이미 세 개로 초대했다면 서버 설정 → 역할에서 그 봇 역할에 Send Messages를 켠다.)
   - 아래 생긴 URL을 열어 회사 서버에 초대한다.
4. 9명을 다 만들었거나 일부만 만들었으면, 아래 명령으로 토큰을 넣는다. 직원 이름이 차례로 나오니 해당 토큰을 붙여 넣고, 없는 직원은 그냥 Enter를 누른다.
   ```
   powershell -ExecutionPolicy Bypass -File C:\ai-office\office\scripts\set-secrets.ps1 -WithStaffBots
   ```
   다른 값을 묻는 칸(Discord 봇 토큰, 웹훅 URL)은 비우고 Enter를 누르면 그대로 둔다.
5. `pm2 restart ai-office`로 다시 켠다. 로그(`pm2 logs ai-office`)에 `직원 봇 연결: pm (기획실장#1234)`처럼 나오면 된다. `직원 봇 로그인 실패: …`가 나오면 그 직원의 토큰을 다시 넣는다.

### 파견 직원 넣고 빼기 (친구 계정, DESIGN 8장)

친구의 Claude·Codex 계정을 잠시 빌려 회사 직원처럼 쓸 수 있다. 친구 계정 사용률 70%까지만 쓴다.

1. 친구가 이 PC 앞에 있을 때 실행한다. 친구가 직접 로그인하고, 키나 비밀번호는 어디에도 붙여 넣지 않는다.
   ```
   powershell -ExecutionPolicy Bypass -File C:\ai-office\office\scripts\add-guest.ps1 -Id minsu -Name 민수 -Provider claude
   ```
   Codex 계정이면 `-Provider codex`. 맡길 역할은 `-Role developer`(기본)·`marketing`·`strategy`·`pm`, 한도는 `-Cap 70`(기본).
2. `protect-secrets.ps1 -IncludeCodexAuth`를 한 번 더 실행해 로그인 폴더를 막는다.
3. Discord에서 `/파견` → [출근]. 퇴근시키려면 [퇴근]. 재시작은 필요 없다.
4. 빼기: `scripts\remove-guest.ps1 -Id minsu` (로그인 폴더도 지울지 묻는다). 친구에게 계정에서 세션을 끊어 달라고도 부탁한다.

## 5. 켜기

```bash
npm run build:screen
```

```bash
npx pm2 start ecosystem.config.cjs
```

```bash
npx pm2 save
```

- 오케스트레이터: 엔진(10초), 알림, Git 고양이, 거울 채널, 회고(1분), 헤르메스 백업(하루 한 번)
- 사무실 화면: http://127.0.0.1:8780 (보기 전용)
- 비서실장 MCP 서버: 헤르메스 `config.yaml`의 `mcp_servers`에 `node C:/ai-office/office/packages/orchestrator/src/mcp/main.ts`

부팅 때 켜지게 하려면 Windows 작업 스케줄러에서 로그인 시 `pm2 resurrect`를 실행한다: `powershell -ExecutionPolicy Bypass -File scripts\register-pm2-autostart.ps1 -StartNow` (작업 이름 `AI_Office_pm2`, 2026-10-19 등록). Claude 앱의 터미널 탭에서 pm2 데몬을 새로 띄우면 앱 재시작 때 같이 꺼지니, 데몬은 이 작업으로 띄운다.

## 6. 자주 쓰는 명령

| 명령 | 하는 일 |
| --- | --- |
| `npm run lint:ds [폴더]` | 디자인 시스템 lint (색·글꼴·4px 간격) |
| `npm run hermes:restore` | 헤르메스 백업 목록 |
| `npm run hermes:restore -- 2026-10-15` | 그날 백업으로 되돌리기 (헤르메스를 끄고) |
| `npm run smoke` | 실제 CLI(claude, codex, ollama) 연결 한 번씩 확인 (비용 조금) |
| `npm run smoke -- --flow` | 임시 저장소로 코딩 지시 하나를 끝까지 (개발자 A 구현 → 개발팀장 검토). Claude·GPT 한도 몇 % 씀 |
| `npm run smoke -- --doc` | 문서 지시 하나를 끝까지 (카피라이터 작성 → 교정 담당 1차 점검 → 검토). 저장소 안 씀 |
| `node src/sim/helper-check.ts` (orchestrator 폴더에서) | 로컬 보조 직원 출력 품질 확인. 로컬 모델만 씀 |
| `node src/sim/codex-write-check.ts` (orchestrator 폴더에서) | Codex 쓰기 샌드박스가 worktree 밖 쓰기·네트워크를 막는지 확인 |

smoke·실험 도구는 모두 메모리 DB를 써서 운영 사무실을 건드리지 않는다. 계획서 결재는 스크립트가 CEO 대신 누른다(시험용).

### 직원 (7단계 조직, DESIGN 2-0)

| 부서 | 직원 | 두뇌 |
| --- | --- | --- |
| CEO실 | 비서실장(헤르메스) | Gemma 4 12B 64K |
| 기획실 | 기획실장(pm) | Claude |
| 품질보증팀 | 교정 담당(qa-local) | Gemma |
| 개발팀 | 개발팀장(developer) | Claude |
| 개발팀 | 개발자 A·B(dev-a, dev-b) | GPT(Codex), worktree 안에서만 쓰기 |
| 개발팀 | 리뷰어 · 감사관(reviewer) | GPT |
| 마케팅 · 콘텐츠팀, 리서치 · 전략팀 | 카피라이터(marketing), 전략가(strategy) | GPT |
| 각 부서 보조 (7-5) | 막힘 해설가, 변경 요약가, 거울 통역사, 커밋 서기, 회고 서기, 보고 초안가, 초안 작가 | Gemma. 판정·검토는 하지 않음 |

Discord에서: `/새프로젝트 아이디`(GitHub 비공개 저장소 + 카테고리 `아이디` › `#작업`을 함께 만든다. `#작업`에서 쓴 `/지시`는 그 저장소 일이 된다), `/지시`(헤르메스 없이 직접 지시), `/정지`, `/재개`, `/보고`, `/설정`, `/push`, `/되돌리기`, `/프로젝트` 등 (9장).

## 7. 한도 회복과 휴식 (2026-10-22)

- 서비스는 30분마다 상한·사용 한도 대기 작업을 점검한다. 마지막 점검 시각은 DB에 남아 재시작해도 이어진다.
- 제공자가 알려 준 초기화 시각을 우선한다. 초기화 정보가 없는 계정은 중지 뒤 5시간 경과와 회사 사용량 여유를 함께 확인하는 추정 방식이다. 주간 한도·제공자 차단·오프라인·CEO 전체 정지는 자동으로 건너뛰지 않는다.
- 계정 한도가 회복되면 `paused(cap)` 티켓에 기본 턴·토큰 몫을 다시 확보하고 중단한 단계로 복귀한다. 토큰 몫은 직전 실제 호출 두 번분 이상을 확보해 계획 추정치가 작은 작업도 이어갈 수 있게 한다. 누적 턴·토큰 기록은 유지한다. 로컬 모델의 작업 안전 상한은 외부 계정 초기화 대상이 아니다.
- 3D 화면은 상한·사용 한도로 멈춘 직원에게 다음 보고까지 1시간 이상 남으면 휴식 자리를 배정한다. 캐릭터별 커피·독서·스트레칭·벤치 휴식을 재생한다. 다른 진행 업무가 있으면 업무를 우선한다.
- 보고까지 1시간 미만이 되거나 작업이 재개되면 원래 업무 자리로 돌아온다. 화면의 시간 조건은 15초마다 확인한다.
