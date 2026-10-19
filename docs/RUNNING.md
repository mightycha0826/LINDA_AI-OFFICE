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
- `secrets.json`: `discordToken`, `mirrorWebhookUrl`, `githubToken`, `internalApiToken`(처음 켤 때 자동으로 만든다).
  - `githubToken`: 세분화된 토큰(fine-grained). `/새프로젝트`로 저장소를 자동으로 만들려면 **Repository access: All repositories**, 권한 **Administration: Read and write**, **Contents: Read and write**(Metadata는 자동). 회사는 DB에 등록된 저장소에만 푸시한다(DESIGN 11장, 2026-10-19 변경).
  - 시스템 봇(LINDA)은 `/새프로젝트`가 카테고리와 `#작업`을 만들 수 있게 서버에서 **채널 관리(Manage Channels)** 권한이 있어야 한다.
  - 값은 손으로 붙여 넣지 말고 `powershell -ExecutionPolicy Bypass -File scripts\set-secrets.ps1`로 넣는다(입력이 화면에 안 보이고, 형식을 검사하고, BOM 없는 UTF-8로 저장). GitHub 토큰까지 넣으려면 `-WithGithub`.

설정 검사에 실패하면 무엇이 틀렸는지 알려 주고 켜지지 않는다.

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

Discord에서: `/새프로젝트 아이디`(GitHub 비공개 저장소 + 카테고리 `아이디` › `#작업`을 함께 만든다. `#작업`에서 쓴 `/지시`는 그 저장소 일이 된다), `/지시`(헤르메스 없이 직접 지시), `/정지`, `/재개`, `/보고`, `/설정`, `/push`, `/되돌리기`, `/프로젝트` 등 (9장).
