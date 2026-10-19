# 헤르메스(비서실장) 설치와 연결

비서실장은 [헤르메스 에이전트](https://github.com/NousResearch/hermes-agent)에 로컬 Gemma 4 12B를 붙여 만든다(설계 6·9장). 처음 설계는 Qwen3-14B였지만 헤르메스가 문맥 64K 미만 모델을 거부해 바꿨다(2026-10-19).
#비서실에서 평소 말투로 대화하면, 비서실장이 회사 도구(MCP)로 지시를 등록하고 상태를 알려 준다.
결재는 여전히 회사 시스템 봇(LINDA)의 버튼으로만 한다.

헤르메스 없이 바로 지시하려면 #비서실에서 `/지시`를 쓴다.

## 0. 준비물 (이미 된 것)

- Ollama와 `gemma4:12b` 모델
- 회사 오케스트레이터 실행 중 (pm2 `ai-office`, 내부 API 127.0.0.1:8790)
- 회사 MCP 서버: `packages/orchestrator/src/mcp/main.ts`. 도구 8개(get_status, get_ticket, get_pending_approvals, get_report_data, get_usage, create_order, request_confirmation, submit_report)가 실제 사무실에 연결되는 것을 확인했다(2026-10-19).

## 1. 비서실장 봇 만들기 (휴대폰 가능)

회사 시스템 봇 LINDA와 **다른 앱**을 하나 더 만든다.

1. https://discord.com/developers/applications → New Application → 이름 예: "비서실장"
2. **Bot** 메뉴:
   - Reset Token → 토큰 복사, **휴대폰 메모에만** 저장 (채팅에 붙이지 않는다)
   - Privileged Gateway Intents: **Message Content Intent 켜기**, **Server Members Intent 켜기** (헤르메스가 대화를 읽으려면 필요). Presence는 꺼도 된다.
   - 회사 시스템 봇 LINDA는 여전히 Message Content를 **끈 채로** 둔다(설계 규칙). 대화를 읽는 건 비서실장 봇뿐이다.
3. **OAuth2 → URL Generator**: Scopes `bot`, `applications.commands` / 권한 View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Create Public Threads, Send Messages in Threads, Add Reactions → 주소를 열어 회사 서버에 초대
4. 비서실장 봇은 **#비서실**에서만 쓰면 충분하다. 다른 채널에서는 권한을 빼도 된다.

## 2. 헤르메스 설치 (PC 앞, PowerShell)

공식 README의 Windows 설치 명령을 그대로 실행한다. 인터넷에서 받은 스크립트를 실행하는 것이라 Claude Code는 대신 실행하지 않는다.

```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```

- 설치 위치: `%LOCALAPPDATA%\hermes` (Python, Node, ripgrep 등을 헤르메스 전용으로 함께 설치한다)
- 설치 뒤 새 PowerShell 창을 열고 `hermes --version`이 나오는지 확인한다.
- 백신이 `%LOCALAPPDATA%\hermes\bin\uv.exe`를 격리하면 그 폴더를 예외로 둔다(README 안내).

## 3. 모델 고르기

```powershell
hermes model
```

- 사용자 지정(OpenAI 호환) 주소를 고르고: 주소 `http://127.0.0.1:11434/v1`, 모델 `gemma4:12b`, 문맥(Context length) `65536`
- 그다음 `config.yaml`의 `model:` 아래에 `ollama_num_ctx: 65536`이 있어야 한다. 없으면 헤르메스가 "below the minimum 64,000"으로 답을 못 한다
- 메뉴 이름은 버전마다 다를 수 있다. 헤르메스 문서의 AI Providers 항목을 따른다.

## 4. 회사 연결 설정 (스크립트)

```powershell
powershell -ExecutionPolicy Bypass -File C:\ai-office\office\scripts\hermes-configure.ps1
```

이 스크립트가 하는 일:

- 헤르메스 `config.yaml`에 회사 MCP 서버(`office`)를 넣는다. 원래 파일은 `.bak-<시각>`으로 남긴다.
- 헤르메스 `.env`에 넣는 것:
  - `DISCORD_ALLOWED_USERS`: 주인 ID만 허용
  - `DISCORD_HOME_CHANNEL`, `DISCORD_FREE_RESPONSE_CHANNELS`: #비서실을 홈으로, 멘션 없이 답하는 채널로
- 비서실장 봇 토큰을 화면에 안 보이게 입력받아 `.env`의 `DISCORD_BOT_TOKEN`에만 저장한다. LINDA 토큰을 잘못 넣으면 거부한다.
- 회사 `config.json`의 `hermes.homeDir`을 채워 매일 백업(설계 6장)이 돌게 한다.

헤르메스 폴더를 못 찾으면 `-HermesHome <폴더>`로 알려 준다. 다시 돌려도 안전하다. 토큰을 바꾸지 않으려면 비우고 Enter, 묻지 않게 하려면 `-NoToken`.

## 5. 켜기와 확인

```powershell
hermes gateway
```

#비서실에 "지금 회사 상태 알려 줘"라고 적어 본다. 비서실장이 `get_status`를 불러 답하면 연결된 것이다.
"로그인 기능 만들어 줘"라고 하면 질문 몇 개 뒤 `create_order`로 지시가 등록되고, PM 계획서가 #결재함에 올라온다.

0단계 #1(도구 호출 5과제)과 #7(Discord 연결)은 이 상태에서 Claude Code가 함께 확인하고 `stage0\RESULTS.md`에 적는다.

## 6. 계속 켜 두기

헤르메스 문서는 Linux의 systemd만 안내한다. Windows에서는 pm2로 함께 띄우는 방법을 쓴다(설치 뒤 Claude Code가 `ecosystem.config.cjs`에 추가한다).
