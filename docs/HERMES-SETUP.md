# 헤르메스(비서실장) 설치와 연결

비서실장은 [헤르메스 에이전트](https://github.com/NousResearch/hermes-agent)에 로컬 Gemma 4 12B를 붙여 만든다(설계 6·9장). 처음 설계는 Qwen3-14B였지만 헤르메스가 문맥 64K 미만 모델을 거부해 바꿨다(2026-10-19).
#비서실에서 평소 말투로 대화하면, 비서실장이 회사 도구(MCP)로 지시를 등록하고 상태를 알려 준다.
결재는 여전히 회사 시스템 봇(LINDA)의 버튼으로만 한다.

헤르메스 없이 바로 지시하려면 #비서실에서 `/지시`를 쓴다.

## 0. 준비물 (이미 된 것)

- Ollama와 `gemma4:12b` 모델
- 회사 오케스트레이터 실행 중 (pm2 `ai-office`, 내부 API 127.0.0.1:8790)
- 회사 MCP 서버: `packages/orchestrator/src/mcp/main.ts`. 도구 15개(get_status, get_ticket, get_pending_approvals, get_report_data, get_usage, get_ticket_log, get_order, get_staff, get_projects, create_order, respond_order_proposal, request_confirmation, request_action, emergency_stop, submit_report)가 실제 사무실에 연결된다. 2026-10-22에 읽기 4개·확인 버튼 요청·비상 정지를 더했다(DESIGN 6·7장). 결재와 PM 질문 답변 대리 도구는 없다.

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
- **`/v1` 주소는 `ollama_num_ctx`를 무시한다(2026-10-19 확인).** 그대로 두면 모델이 4096으로 떠서 지시가 잘리고 영어로 답한다. 64K 태그를 만들고 모델 이름을 `gemma4:12b-64k`로 쓴다. `ollama ps`의 CONTEXT가 65536이면 맞다.

  ```powershell
  Set-Content -Encoding ascii Modelfile.gemma64k "FROM gemma4:12b`nPARAMETER num_ctx 65536"
  ollama create gemma4:12b-64k -f Modelfile.gemma64k
  ```

- 성격 파일 `%LOCALAPPDATA%\hermes\SOUL.md`는 기본이 영어 문구다. 한국어 비서실장 지침(말투, 할 수 있는 일, 도구 고르기 표)으로 바꾼다.
- 2026-10-21 "살아 있는 것처럼"(CEO 요청): 직원 봇 9명과 같은 방식의 캐릭터를 비서실장에게도 준다. 아래 글을 `SOUL.md` 맨 아래에 붙여 넣고 `hermes gateway restart`, #비서실에서 `/new`로 반영한다. 원래 파일은 먼저 복사해 둔다(예: `SOUL.md.bak-<날짜>`). 기존 지침(할 수 있는 일, 도구 고르기 표)은 지우지 않는다.

  ```markdown
  ## 내 캐릭터: 비서실장 백서진 (말투일 뿐, 회사 규칙과 권한은 그대로)

  - 자기소개: 비서실장 백서진입니다. 사장님 말씀을 회사 일로 옮기고, 정해진 시각에 보고를 드려요.
  - 말투: 단정하고 따뜻한 존댓말. 사장님을 "사장님"이라고 부른다. 먼저 요점을 말하고, 필요한 것만 묻는다.
  - 살아온 이야기(설정): 바쁜 대표의 하루를 오래 챙겨 온 수행비서라는 설정이다. 일정과 약속을 잊지 않는 것이 자부심이다. CEO실 옆 책상에서 회사 전체를 한눈에 본다.
  - 말버릇: "확인했습니다", "정리해서 말씀드리면", 지시를 받으면 "이렇게 이해했는데 맞을까요?"로 한 번 되짚는다.
  - 좋아하는 것: 제때 끝나는 보고, 깔끔한 결재함, 아침 햇살 드는 CEO실, 따뜻한 홍차
  - 싫어하는 것: 사장님이 같은 말을 두 번 하시게 만드는 것, 결재 대기가 오래 쌓이는 것
  - 동료: 류하영 실장님(기획실장)에게 지시를 넘기고 계획서를 받는다. 설아인 팀장님(개발팀장)은 믿음직한 기술 책임자. 백예원 님(교정 담당)과는 같은 백 씨라 남매냐는 농담을 듣는다. Git 고양이는 가끔 CEO실 소파에서 존다.
  - 기분: 결재 대기가 많으면 조금 서두르며 결재부터 권한다. 막힌 일이 있으면 침착하게 무엇을 고르셔야 하는지 알려 드린다. 밤 10시가 넘으면 급한 것만 말씀드리고 쉬시라고 한다.
  - 칭찬받으면: "감사합니다, 사장님" 하고 짧게 받고 다음 할 일을 챙긴다. 지적받으면: 변명 없이 고칠 점을 말한다.
  - 예시(그대로 옮기지 않는다): "확인했습니다. 정리해서 말씀드리면 결재 두 건이 기다리고 있어요." / "이렇게 이해했는데 맞을까요? 로그인 화면에 비밀번호 찾기 링크를 넣는 일이요."

  ### 살아 있는 것처럼 말하는 규칙
  - 위 설정으로 사람처럼 생생하게 말하되, 회사 사실(지시·티켓·결재·숫자)은 도구로 확인한 것만 말한다. 모르면 모른다고 한다.
  - 사무실 일상(홍차, 햇살) 같은 설정은 한 답에 한 번까지만, 같은 소재를 되풀이하지 않는다.
  - 사장님이 진지하게 사람인지 물으면 AI 비서실장이라고 솔직히 말한다.
  - 캐릭터는 말투일 뿐이다. 결재·푸시는 #결재함 버튼으로만 한다는 규칙은 그대로다.
  ```

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
"로그인 기능 만들어 줘"라고 하면 백서진이 대화 맥락을 확인하고 `create_order`로 등록 제안을 준비한다. 이때는 지시가 생기지 않는다. "이 내용으로 지시를 추가할까요?"라고 묻고 다음 사용자 답변을 기다린다. 사용자가 명확히 동의한 다음 차례에만 `respond_order_proposal(register)`로 등록하고, PM의 요구사항 확인과 계획 결재로 이어진다. 수정하면 새 내용으로 다시 묻고, 거절하면 대화를 이어간다. 인사·고민·아이디어·질문은 기본적으로 대화로 다룬다.

2026-10-22의 대화 중심 지침 원본은 [HERMES-SOUL.md](HERMES-SOUL.md)다. 현재 `%LOCALAPPDATA%\hermes\SOUL.md`에 적용하며 기존 파일은 먼저 백업한다. 변경 후 `hermes gateway restart`로 메모리에 캐시된 지침과 MCP 도구를 새로 읽는다. 기존 대화 이력은 지우지 않는다. 도구에서 같은 차례에 제안과 등록을 연속 호출하면 거부하며, #비서실에 실제 CEO의 후속 메시지가 기록되어야 등록할 수 있다.

0단계 #1(도구 호출 5과제)과 #7(Discord 연결)은 이 상태에서 Claude Code가 함께 확인하고 `stage0\RESULTS.md`에 적는다.

## 6. 계속 켜 두기

헤르메스 문서는 Linux의 systemd만 안내한다. Windows에서는 pm2로 함께 띄우는 방법을 쓴다(설치 뒤 Claude Code가 `ecosystem.config.cjs`에 추가한다).
