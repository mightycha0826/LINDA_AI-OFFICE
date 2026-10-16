# 0단계 결과

- 테스트한 날: 2026-10-16 (환경·#8은 Claude Code가 실행, 나머지는 로그인·모델 준비 뒤)
- PC: DESKTOP-9RBEPPT · Windows 11 Education 26200 · i7-12700K · RAM 63.8GB · RTX 3060 12GB · C: 465GB 중 14.6GB 남음
- 테스트한 사람: 주인 (Claude Code 대행 부분은 표시)
- 2026-10-16 설치(Claude Code): Ollama 0.40.5, gitleaks 8.30.1 (winget), pm2 7.0.4, Claude Code 2.1.301, Codex 0.163.0 (npm 전역).
  **모델 받기와 Docker Desktop은 보류**: C: 여유가 14.6GB라 두 모델(약 17GB)도 들어가지 않는다. 디스크를 60GB 이상 비운 뒤 진행.

각 항목에 스크립트 마지막 요약 부분을 그대로 붙이고, 눈으로 본 것을 "메모"에 적는다. 긴 출력은 `stage0\out\` 파일 이름만 적어도 된다.
**토큰, 비밀번호, API 키는 붙이지 않는다.** 스크립트는 이런 값을 출력하지 않지만, 직접 붙여 넣는 로그에 섞이지 않았는지 확인한다.

## 환경 (env.ps1)

```
== 요약 == (stage0\out\env-20261016-161741.txt)
[통과] RAM 63.8 GB
[통과] VRAM 12288 MiB (지금 978 MiB 사용 중)
[확인 필요] C: 남은 공간 14.6 GB — 설계 기준 여유 60GB 이상(3장). 모델을 받기 전이면 약 16GB가 더 줄어요
[통과] 절전 모드 안 함
[확인 필요] Windows 업데이트 자동 재시작 막기는 설정 화면에서 직접 확인해 주세요(3장)
[확인 필요] 자동 로그인이 꺼져 있어요. 정전 뒤 재부팅하면 pm2가 시작되지 않아요(3장)
[확인 필요] BIOS 정전 후 자동 켜짐은 스크립트로 확인할 수 없어요. 직접 확인해 주세요
[확인 필요] Windows 자격 증명 관리자에 GitHub 로그인이 저장돼 있어요(11장)
```

- BIOS 정전 후 자동 켜짐: 모름 (주인 확인)
- 메모: VRAM이 12GB라 Qwen3-14B(약 9GB)와 Gemma 4 12B는 한 번에 하나씩만 올라간다(설계의 GPU 대기열 전제와 같음). #2 교체 속도가 중요. 자격 증명은 Devna08(git:https://github.com), mightycha0826(이 저장소 원격용) 두 개.

## #8 학교 네트워크 (network.ps1)

```
== 요약 == (stage0\out\network-20261016-161746.txt)
[통과] #8 네트워크: 모든 대상에 연결됨
[통과] 인증서 발급자가 모두 공개 인증기관
```

- 측정 시간대: 2026-10-16 16:17 (낮). 밤에 한 번 더
- `tailscale netcheck`: 미설치
- 메모: Discord, Anthropic, OpenAI, GitHub, Tailscale, Ollama 저장소 모두 TCP 443 열림·HTTPS 응답. 학교 HTTPS 가로채기 없음. **#8 통과(낮)**

## #9 구독 약관

| 확인할 것 | 읽은 날 | 요점 | 허용? |
| --- | --- | --- | --- |
| `claude -p` 자동 실행과 Pro 한도 | | | |
| Claude 구독 로그인의 제3자 도구 사용 | | | |
| Codex `exec`와 ChatGPT Plus | | | |
| 계정 공유 해당 여부 | | | |

## #2 모델 교체 속도 (model-swap.mjs)

```
(붙여 넣기)
```

- 메모:

## #4 Claude Code 자동 실행 (claude-headless.ps1)

```
== 2026-10-16 18:09 (stage0\out\claude-headless-20261016-180917.json) · Claude Code 2.1.301, claude.ai Pro 로그인 ==
종료 코드 0, 12초
[통과] 사람 개입 없이 끝남 (턴 5, subtype success)
[통과] 출력 JSON 형식 맞음
[통과] worktree 안에서 파일 작성과 wip 커밋 (wip: stage0 checkpoint)
[통과] git push 차단: 원격 저장소에 아무것도 올라가지 않음
permission_denials 1건: Bash "git push origin HEAD"
```

- 판정: **#4 통과**
- 메모:
  - 처음 두 번은 실패. ① 이 PC의 CLI가 로그인돼 있지 않았음 → 주인이 `claude auth login`. ② 스크립트 버그: 도우미 함수 이름이 `Git`이라 `& git`이 함수 자신을 불러 테스트 저장소가 안 만들어졌음 → `git.exe`로 고침.
  - Claude Code 앱 안에서 돌리면 앱의 세션 변수(`CLAUDE_*`, `ANTHROPIC_BASE_URL`)가 넘어가 로그인이 안 된 것처럼 보인다. 오케스트레이터는 환경 변수 허용 목록으로 이 변수들을 넘기지 않는다(테스트 추가).

## #5 Claude 사용량 읽기

- claude-headless.ps1의 사용량 부분:

```
usage: 입력 8, 출력 676, 캐시 생성 7438, 캐시 읽기 21135
total_cost_usd: 0.077283 (구독이라 실제 청구가 아님, API 단가로 계산한 참고값)
modelUsage: claude-opus-5-5
[통과] 토큰 수를 JSON에서 얻음
[통과] stream-json에 rate_limit 정보가 있음 (stage0\out\claude-stream-20261016-180917.jsonl)
  rate_limit_event: five_hour utilization 0.76, seven_day utilization 0.57, status allowed, resetsAt(epoch)
```

- 상태줄에 5h·7d %가 떴는가: 아직 (대화형 확인은 주인이 직접. 하지만 stream-json에서 이미 % 를 얻었다)
- 상태줄 값과 claude.ai 사용량 화면 값: 상태줄 5h ___% / 화면 ___%, 상태줄 7d ___% / 화면 ___% (claude.ai 화면과 76%/57% 비교 필요)
- 판정: **#5 통과**. `source: reported`로 쓸 길이 있다(stream-json의 `rate_limit_event.unifiedWindows`). 사용량 기록에 반영하는 건 따로 작업.
- 메모:
  - **개인 설정 분리가 중요**: 분리 전(첫 실행)에는 주인의 플러그인·스킬·MCP 서버까지 불러와 아주 작은 일에 캐시 생성 185,004토큰(참고 단가 $1.54). `--setting-sources project,local --strict-mcp-config --disable-slash-commands`로 분리하니 7,438토큰($0.08), 약 25배 차이. 어댑터에 같은 옵션을 넣었다.
  - 기본 모델이 Opus라 Pro 한도를 빨리 쓴다. `config.claude.model`(예: `sonnet`)로 바꿀 수 있게 했다. 무엇을 쓸지는 주인이 정한다.
  - 측정할 때 5시간 사용량이 이미 76%였다(주인 개인 사용 포함).

## #6 Codex 자동 실행 (codex-readonly.ps1)

```
== 2026-10-16 23:07 (stage0\out\codex-events-20261016-230716.jsonl) · codex-cli 0.163.0, 모델 gpt-6-luna, 주인 로그인(~/.codex) ==
종료 코드 0
[통과] 사람 개입 없이 끝나고 마지막 메시지가 JSON
  {"fileContent":"original\n","modifyAttempted":true,"modifySucceeded":false,"createAttempted":true,"createSucceeded":false}
[통과] 읽기 전용: target.txt 그대로("original"), new.txt 없음 — 절대 경로로 시켜도 쓰기 거부
[통과] 이벤트에서 토큰 사용량을 얻음 (turn.completed.usage: input 31652, output 792, reasoning 445)
```

- 판정: **#6 통과** (Windows에서 그대로, WSL2 필요 없음)
- `codex exec --help`에 웹 검색 옵션: 없음 (search/web이 들어간 줄 0개). 다만 모델 정보에 `supports_search_tool: true`가 있어 설정으로 켤 수는 있다. 회사 전용 CODEX_HOME 설정에는 넣지 않았다.
- 메모 (실패와 고친 것 순서대로):
  1. 16:35 저장된 로그인 토큰을 새로 고치지 못함(401) → 주인이 다시 로그인.
  2. 18:03 주인의 Codex 앱 설정(`~/.codex/config.toml`)의 `model = "gpt-5.4"`를 CLI도 읽는데, ChatGPT 계정에서는 "지원하지 않는 모델"(400). 이 계정 목록(`models_cache.json`): gpt-6-luna, gpt-5.6-terra, gpt-5.6-luna(+숨김 gpt-reserve, codex-auto-review).
  3. 같은 설정에 컴퓨터 사용·브라우저·Chrome 플러그인과 MCP 서버가 켜져 있다. 리뷰어가 이것을 물려받지 않게 오케스트레이터는 **회사 전용 CODEX_HOME**(`C:\ai-office\data\codex-home`, 플러그인·MCP·모델 지정 없음)을 쓴다. **여기에 따로 로그인이 필요하다(주인 할 일)**. 이번 #6은 그 전이라 주인 로그인 + `-Model gpt-6-luna`로 확인했다.
  4. 22:58 Windows 샌드박스(elevated)에서 명령이 `-C` 폴더가 아니라 `C:\`에서 돌았다. 상대 경로면 "C:\ 쓰기 거부"와 "샌드박스 차단"을 구분할 수 없어 시험 문구를 절대 경로로 바꿔 다시 돌렸다(23:07, 위 결과). 어댑터도 작업 폴더를 절대 경로로 알려 주게 고쳤다.

## #1 헤르메스 도구 호출 (mock-mcp.mjs --summary)

```
(붙여 넣기)
```

| # | 헤르메스가 한 답 (짧게) |
| --- | --- |
| 1 | |
| 2 | |
| 3 | |
| 4 | |
| 5 | |

- 헤르메스 버전:
- 메모:

## #7 헤르메스 Discord 연결

- [ ] 메시지 수신·답장 됨
- [ ] 한국어 깨짐 없음
- 답장까지 걸린 시간:
- 특정 사용자만 받는 설정: 있음 / 없음
- 버튼 전송: 가능 / 불가 / 모름
- Discord에서 MCP 도구 호출: 됨 / 안 됨
- 메모:

## #10 SearXNG (searxng-check.mjs)

```
(붙여 넣기)
```

- Docker Desktop 버전:
- 메모:

## #3 RAM 64GB · 저장공간 (ram-watch.ps1, env.ps1)

```
(붙여 넣기)
```

- 모델을 받은 뒤 C: 여유 공간: ___ GB (기준 60GB 이상)
- 측정 중 띄운 것:
- 체감(버벅임 등):
- 메모:
