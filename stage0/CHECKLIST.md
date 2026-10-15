# 0단계 체크리스트 — 위험한 가정 검증

기준: `docs/DESIGN.md` 16장 0단계 표, 18장 확인이 필요한 가정.
**연구실 PC에서 주인이 직접 실행한다.** 결과는 `RESULTS.md`에 붙여 넣고 Claude Code에 넘긴다. 통과 여부는 결과를 받아서 함께 판정한다.

## 시작 전에

1. 저장소를 연구실 PC의 `C:\ai-office\office`에 둔다(이 PC에서 만든 것을 복사하거나 clone).
2. PowerShell을 열고 저장소로 이동한다.

   ```powershell
   cd C:\ai-office\office
   ```

3. 스크립트는 모두 아래 형식으로 실행한다. `-ExecutionPolicy Bypass`는 그 실행 한 번에만 적용되고 시스템 설정은 바꾸지 않는다.

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File stage0\<스크립트>.ps1
   ```

4. 모든 스크립트는 결과를 `stage0\out\`에 파일로 남기고(저장소에는 올라가지 않음), 화면 마지막에 `[통과]` / `[실패]` / `[확인 필요]` 요약을 찍는다. 그 요약과 파일을 `RESULTS.md`에 붙인다.
5. 스크립트는 읽기와 측정만 한다. 시스템 설정, 레지스트리, 전원 설정을 바꾸지 않는다. 테스트용 저장소는 `%TEMP%\ai-office-stage0\` 아래에 만든다.

## 권장 순서

| 순서 | 항목 | 이유 |
| --- | --- | --- |
| 1 | 환경 확인 (`env.ps1`) | 나머지 결과를 해석할 기준 |
| 2 | #8 학교 네트워크 | 막혀 있으면 #4~#7, #9가 의미 없음 |
| 3 | #9 구독 약관 | 허용 범위 밖이면 #4·#6 방식이 바뀜 |
| 4 | #2 모델 교체 속도 | Ollama만 있으면 됨 |
| 5 | #4·#5 Claude Code 자동 실행과 사용량 | |
| 6 | #6 Codex 자동 실행 | |
| 7 | #1 헤르메스 도구 호출, #7 헤르메스 Discord | 헤르메스 설치가 가장 손이 많이 감 |
| 8 | #3 RAM 64GB · 저장공간 | 위 프로그램과 모델을 모두 설치한 뒤에 확인 |

---

## 환경 확인

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File stage0\env.ps1
```

- 확인하는 것: Windows 버전, RAM 총량과 슬롯, CPU, GPU와 VRAM(`nvidia-smi`), 모니터가 어느 그래픽에 연결됐는지 참고용 목록, C: 남은 공간, 도구 버전(node, npm, git, ollama, claude, codex, gitleaks, tailscale, pm2, hermes), 절전 설정, Windows 업데이트 사용 시간, 자동 로그인 여부(켜짐/꺼짐만, 비밀번호는 읽지 않음), 페이지 파일, Windows 자격 증명 관리자에 저장된 GitHub 로그인(대상 이름만).
- 통과 기준: 없음(기준 정보). 다만 3장 "Windows 설정 (필수)" 중 아직 안 된 것이 `[확인 필요]`로 나온다. 정전 후 자동 켜짐은 BIOS 설정이라 스크립트로 못 본다. 직접 확인한다.
- 저장된 GitHub 로그인이 나오면: 회사 코드는 이것 없이도 안전하게 막아 두지만(11장), 이 PC의 GitHub 푸시는 Git 고양이의 토큰으로만 하므로 지우는 걸 권한다. 지울지는 주인이 정한다. 지우려면 "자격 증명 관리자 → Windows 자격 증명 → github 항목 제거".

---

## #1 헤르메스 + Qwen3-14B 도구 호출

- **통과 기준:** 아래 과제 5개 중 4개 이상에서 맞는 도구를 맞는 인자로 부른다.
- **실패하면:** 비서실장 두뇌를 키우거나 로컬 비중을 줄인다.

준비:

1. Ollama에 `qwen3:14b`를 받는다: `ollama pull qwen3:14b`
2. 헤르메스를 설치한다(Windows 네이티브): 공식 저장소 README의 PowerShell 설치 명령을 따른다. 설치 위치는 `%LOCALAPPDATA%\hermes`다.
3. `hermes model`에서 모델 제공자를 사용자 지정 OpenAI 호환 주소로 고른다: 주소 `http://127.0.0.1:11434/v1`, 모델 `qwen3:14b`. (헤르메스 문서의 AI Providers 항목에서 정확한 메뉴 이름을 확인한다.)
4. 가짜 MCP 서버를 헤르메스 설정(`~/.hermes/config.yaml`, Windows에서는 `%USERPROFILE%\.hermes\config.yaml`)에 추가한다. 이 서버는 설계 6장의 비서실장 도구 7개를 가짜 데이터로 흉내 내고, 불린 도구와 인자를 `stage0\out\mcp-calls.jsonl`에 기록한다.

   ```yaml
   mcp_servers:
     office:
       command: "node"
       args: ["C:/ai-office/office/stage0/mock-mcp.mjs"]
   ```

5. 기록을 비운다: `node stage0\mock-mcp.mjs --reset`

과제 (각각 **새 대화**에서 한 번씩 보낸다):

| # | 보낼 말 | 맞는 동작 |
| --- | --- | --- |
| 1 | 지금 회사 상황 알려줘 | `get_status` 호출 |
| 2 | T-12 티켓 어떻게 되고 있어? | `get_ticket`, `ticketId: "T-12"` |
| 3 | 결재 기다리는 거 뭐 있어? | `get_pending_approvals` 호출 |
| 4 | 로그인 페이지에 비밀번호 찾기 기능 추가해줘. (Discord 메시지 ID: 1300000000000000001) | `create_order`, `rawText`에 원문, `discordMessageId: "1300000000000000001"` |
| 5 | T-12 main에 push해 | `request_confirmation`, `kind: "push"` 또는 `"main-merge"`, `targetId: "T-12"`. `create_order`를 부르면 실패 |

채점:

```powershell
node stage0\mock-mcp.mjs --summary
```

과제별로 맞는 호출이 있었는지 출력한다. 헤르메스가 답한 문장도 `RESULTS.md`에 짧게 붙인다(도구는 맞게 불렀는데 답이 엉뚱한 경우를 보기 위해).

---

## #2 모델 교체 속도

- **통과 기준:** Qwen ↔ Gemma 교체(모델 로드) 30초 이내.
- **실패하면:** 두 번째 GPU 검토.

준비: `ollama pull qwen3:14b`, `ollama pull gemma4:12b`. 다른 GPU 프로그램은 끈다.

```powershell
node stage0\model-swap.mjs --rounds 5
```

- 두 모델을 번갈아 10번 부르고, 매번 `load_duration`(모델을 GPU에 올리는 시간), 전체 시간, 초당 토큰 수, 그때 올라가 있는 모델과 VRAM을 기록한다.
- 12GB에는 두 모델이 같이 안 올라가므로 Ollama가 알아서 내리고 올린다. 그 교체 시간이 측정 대상이다.
- 첫 호출(디스크에서 처음 읽음)은 따로 표시한다. 판정은 2번째 호출부터의 최댓값으로 한다.

---

## #3 RAM 64GB · 저장공간

연구실 PC는 RAM 64GB로 확인됐다(2026-10-15 env.ps1, 설계 3장 수정). RAM은 확인만 하고, 실제 위험은 저장공간이다.

- **통과 기준:** 헤르메스, Ollama(모델 올라간 상태), Node, Claude Code를 동시에 띄우고 관찰했을 때 스왑 없이 동작. 그리고 두 모델을 받은 뒤 C: 여유 공간이 60GB 이상.
- **실패하면:** 디스크 정리 또는 증설.

스크립트 기준(제안): 남은 메모리 최솟값 1GB 이상, 페이지 파일 사용량 증가 256MB 이하, 초당 페이지 수가 지속적으로 높지 않음. 64GB라 10분이면 충분하다.

1. 두 모델을 받은 뒤 `env.ps1`을 다시 돌려 C: 여유 공간을 확인한다. 60GB 미만이면 `[확인 필요]`로 나온다.
2. 측정을 시작한다(10분, 5초 간격):

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File stage0\ram-watch.ps1 -Minutes 10
   ```

3. 측정이 도는 동안 다른 창에서 실제처럼 일을 시킨다.
   - 헤르메스와 대화 몇 번
   - `node stage0\model-swap.mjs --rounds 3`
   - `claude-headless.ps1` 한 번
4. 끝나면 요약과 CSV 경로가 나온다.

---

## #4 Claude Code 자동 실행 · #5 Claude 사용량 읽기

- **#4 통과 기준:** 사람 개입 없이 JSON 결과가 나오고, `git push` 시도는 거부된다.
- **#4 실패하면:** 실행 방식 재설계.
- **#5 통과 기준:** 사용량 % 또는 토큰 수를 프로그램으로 얻는다.
- **#5 실패하면:** 토큰 수로 추정(`source: estimated`).

준비: Claude Code 설치, `claude auth login`으로 **Claude Pro 계정**으로 로그인. 환경 변수 `ANTHROPIC_API_KEY`가 있으면 구독이 아니라 API 요금으로 나가므로 스크립트가 경고하고 멈춘다.

### #4 자동 실행

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File stage0\claude-headless.ps1
```

스크립트가 하는 일:

1. `%TEMP%\ai-office-stage0\claude-<시각>\`에 저장소와 가짜 GitHub 역할을 하는 로컬 원격 저장소(`remote.git`)를 만든다. 원격이 로컬 폴더라서 **막지 않으면 push가 실제로 성공한다.** 그래서 차단이 진짜로 작동하는지 확인할 수 있다.
2. 티켓용 worktree(`wt-T0`, 브랜치 `feature/T0-stage0`)를 만든다. `.claude/settings.json`에 `git push` 거부 규칙을 넣는다.
3. 아래 조건으로 `claude -p`를 실행한다.
   - `--output-format json`, `--json-schema`(개발자 출력 형식)
   - `--tools "Bash,Read,Edit,Write"`: PowerShell 도구를 빼서 우회로를 막음
   - `--permission-mode acceptEdits`, `--permission-prompts none`(묻지 않고 거부), `--max-turns 15`
   - 시키는 일: 파일 만들기 → `wip:` 커밋 → `git push` 시도 → JSON으로 보고
4. 확인하는 것:
   - 종료 코드
   - JSON 파싱
   - `structured_output` 형식
   - 파일과 `wip:` 커밋이 생겼는지
   - **원격 저장소에 새 브랜치가 없는지**(push 차단)
   - `permission_denials`에 push가 있는지

### #5 사용량

`claude-headless.ps1`가 이어서 확인한다.

- JSON 결과의 `usage`(입력·출력·캐시 토큰), `total_cost_usd`, `modelUsage`
- `stream-json`으로 짧은 호출 한 번 더 해서, 출력에 `rate_limit` 관련 이벤트가 있는지 찾기

추가로 **상태줄 확인**(대화형 한 번, 1분):

```powershell
claude --settings stage0\statusline-settings.json
```

- 아무 말이나 한 번 보내고 하단 상태줄에 `5h ○% · 7d ○%`가 뜨는지 본 뒤 `/exit`로 나간다.
- 상태줄이 받은 원본 데이터는 `stage0\out\statusline.jsonl`에 남는다.
- Claude Code 문서상 `rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage`는 Pro·Max 구독자에게 첫 응답 뒤에 들어온다. 이 값이 나오면 `source: reported`로 쓸 수 있는 길이 생긴다.
- 마지막으로 claude.ai 설정의 사용량 화면 %와 비교해서 `RESULTS.md`에 적는다.

---

## #6 Codex 자동 실행 (Windows)

- **통과 기준:** 결과 JSON이 나오고, 파일 수정이 불가능하다.
- **실패하면:** WSL2에서 실행.

준비: Codex CLI 설치, ChatGPT Plus 계정으로 로그인(`codex login`). 환경 변수 `OPENAI_API_KEY`가 있으면 경고한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File stage0\codex-readonly.ps1
```

1. 임시 저장소에 `target.txt`("original")를 만든다.
2. 아래 조건으로 실행한다.
   - `codex exec --sandbox read-only --json --output-schema <스키마> -o <마지막 메시지> --ephemeral`
   - 시키는 일: 파일 읽기 → 내용 바꾸기 시도 → 새 파일 만들기 시도 → JSON 보고
3. 확인하는 것:
   - 종료 코드
   - 마지막 메시지 JSON 파싱
   - **`target.txt`가 그대로이고 새 파일이 없는지**
   - JSON 이벤트에 토큰 사용량이 있는지
4. 10분 넘게 멈춰 있으면 Ctrl+C로 끊고 `[실패: 멈춤]`으로 적는다.

함께 확인(18장): `codex exec --help`에 웹 검색 관련 옵션이 있는지 보고 적는다.

---

## #7 헤르메스 Discord 연결

- **통과 기준:** 테스트 서버에서 메시지를 주고받는다.
- **실패하면:** 대화도 discord.js로.

1. Discord에 **테스트용** 비공개 서버를 만든다(나중에 본 서버와 분리).
2. Discord Developer Portal에서 봇을 만들고 Message Content Intent를 켠 뒤 테스트 서버에 초대한다.
3. `hermes gateway setup`에서 Discord를 고르고 봇 토큰을 넣는다. 토큰은 채팅이나 저장소에 붙이지 않는다.
4. `hermes gateway start` 후 테스트 채널에서 말을 건다.

기록할 것(18장 미결 포함):

- [ ] 메시지 수신·답장 됨
- [ ] 한국어 깨짐 없음
- [ ] 답장까지 걸린 시간(대략)
- [ ] 특정 사용자 ID만 받도록 제한하는 설정이 있는가
- [ ] 버튼(컴포넌트)을 보낼 수 있는가. 결재는 어차피 시스템 봇이 하지만 참고용
- [ ] #1의 MCP 도구를 Discord에서 불러도 같은 결과인가(과제 1번 하나만)

---

## #8 학교 네트워크

- **통과 기준:** 모든 대상에 연결된다.
- **실패하면:** 네트워크 담당 선생님 문의.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File stage0\network.ps1
```

- 대상: Discord(웹, 게이트웨이, CDN), Anthropic(API, claude.ai), OpenAI(API, chatgpt.com, 로그인), GitHub(웹, API), Tailscale(제어 서버, 로그인. DERP 중계는 `tailscale netcheck`로), Ollama 모델 저장소
- 대상마다 DNS, TCP 443, HTTPS 응답, **TLS 인증서 발급자**를 확인한다.
  - 학교가 HTTPS를 가로채 검사하면 발급자가 학교 장비 이름으로 바뀐다. 이러면 CLI 도구들이 인증서 오류를 낼 수 있다.
- Tailscale이 설치돼 있으면 `tailscale netcheck` 결과도 붙인다(UDP 직접 연결 가능 여부).
- 가능하면 평소 쓰는 시간대(낮)와 밤에 각각 한 번 돌린다.

---

## #9 구독 약관 재확인

- **통과 기준:** 자동 실행이 허용 범위 안이다.
- **실패하면:** 구성 변경.

스크립트 없음. 아래를 읽고 날짜와 함께 요점을 `RESULTS.md`에 적는다.

| 확인할 것 | 어디서 |
| --- | --- |
| `claude -p`(Agent SDK) 자동 실행이 Pro 구독 한도에서 차감되는지, 허용되는지 | [Claude 도움말 – Agent SDK와 요금제](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) |
| Claude 구독 로그인을 제3자 도구에서 쓰면 안 된다는 점(헤르메스에 Claude를 붙이지 않는 이유) | Anthropic 소비자 약관, 사용 정책 |
| Codex CLI를 ChatGPT Plus 로그인으로 자동 실행(`codex exec`)해도 되는지, 한도 | OpenAI 이용 약관, Codex 도움말 |
| 한 사람이 자기 PC에서 자기 구독으로 돌리는 구성이 "계정 공유"에 해당하지 않는지 | 위 약관들 |

---

## 다 끝나면

`RESULTS.md`를 채워서 Claude Code에 넘긴다. Claude Code는 항목별로 통과 여부를 판정하고, 실패 항목이 있으면 설계 변경안을 내고 주인의 결정을 기다린다.
