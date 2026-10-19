# 0단계 결과

- 테스트한 날: 2026-10-16 (환경·#8은 Claude Code가 실행, 나머지는 로그인·모델 준비 뒤)
- PC: DESKTOP-9RBEPPT · Windows 11 Education 26200 · i7-12700K · RAM 63.8GB · RTX 3060 12GB · C: 465GB 중 14.6GB 남음
- 테스트한 사람: 주인 (Claude Code 대행 부분은 표시)
- 2026-10-16 설치(Claude Code): Ollama 0.40.5, gitleaks 8.30.1 (winget), pm2 7.0.4, Claude Code 2.1.301, Codex 0.163.0 (npm 전역).
  **모델 받기와 Docker Desktop은 보류**: C: 여유가 14.6GB라 두 모델(약 17GB)도 들어가지 않는다. 디스크를 60GB 이상 비운 뒤 진행.
- 2026-10-19: 주인이 디스크를 비움(79GB). qwen3:14b·gemma4:12b 받음(남은 62GB). Docker Desktop은 WSL이 없어 관리자 설치와 재부팅이 필요해 보류(주인 결정).

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
| `claude -p` 자동 실행과 Pro 한도 | 2026-10-19 (Claude Code 조사) | 2026-06-15에 예고됐던 Agent SDK·`claude -p` 별도 과금 변경은 **보류**됐고, 지금도 구독 한도(5시간·주간)에서 차감. 10-07부터 Max·Team에 월 API 크레딧이 생겼지만 Pro는 해당 없음 | 허용으로 보임 (주인 확인) |
| Claude 구독 로그인의 제3자 도구 사용 | 2026-10-19 | 구독 로그인은 "개인의 일반 사용" 용도. 다른 사람에게 제공하는 제품·서비스는 API 키를 쓰라는 안내. 이 회사는 주인 혼자 쓰는 개인 도구라 해당 없음으로 보임 | 주인 확인 |
| Codex `exec`와 ChatGPT Plus | 2026-10-19 | Plus에 Codex CLI 포함, 플랜 사용 한도 적용. ChatGPT 이용약관이 적용되고 자동 실행을 따로 금지하는 문구는 못 찾음. 여러 사람이 쓰는 CI 같은 곳은 API 키를 권장 | 허용으로 보임 (주인 확인) |
| 계정 공유 해당 여부 | 2026-10-19 | 두 계정 모두 주인 한 사람이 자기 PC에서만 씀. 다른 사람에게 로그인을 넘기거나 서비스로 열지 않음 | 해당 없음 |

- 출처: [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [Monthly API credits for Max and Team plans](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans), [Codex Pricing](https://developers.openai.com/codex/pricing), [Codex 도움말](https://help.openai.com/articles/11369540)
- 공식 문서와 블로그 요약을 함께 본 것이라, 최종 판단은 주인이 원문을 읽고 "허용?" 칸을 확정한다.

## #2 모델 교체 속도 (model-swap.mjs)

```
== 2026-10-19 10:49 (stage0\out\model-swap-2026-10-19T01-49-49-569Z.json) · Ollama 0.40.5, qwen3:14b ↔ gemma4:12b, 5회씩 ==
 1. qwen3:14b   로드 39.6초 (디스크에서 처음)   1.4 tok/s(첫 호출)
 2. gemma4:12b  로드 40.3초 (디스크에서 처음)  48.2 tok/s
 3~10. 교체 로드: qwen 4.1~4.3초 (33 tok/s), gemma 6.5~6.6초 (44~60 tok/s)
교체 로드: 중간값 4.3~6.5초, 최댓값 6.6초 (기준 30초 이내)
```

- 판정: **#2 통과**. 모델마다 첫 로드(디스크에서 처음 읽음, 약 40초)는 부팅 뒤 한 번뿐이라 뺐다.
- 메모:
  - 처음 스크립트는 "첫 호출 하나만" 뺐는데, 두 번째 모델의 첫 로드(40.3초)도 디스크 읽기라 [실패]로 나왔다. 모델마다 첫 호출을 빼도록 스크립트를 고쳤다(설계 기준의 뜻과 같음).
  - VRAM: qwen3:14b 9.0GB가 올라가고, gemma4:12b는 `ollama ps` 기준 1.1GB만 GPU에 올라간 것으로 나왔다. 그래도 44~60 tok/s라 실사용에는 문제없다.
  - `npm run smoke --only ollama`(실제 어댑터): Qwen 7.2초, Gemma 7.6초, 다시 Qwen 6.6초 모두 구조화 출력 통과. GPU 대기열 순서 qwen → gemma → qwen.

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
- 2026-10-19 10:02 **회사 전용 CODEX_HOME 로그인으로 다시 확인: 통과** (모델 지정 없음 = 계정 기본, 37초, `stage0\out\codex-events-20261019-100244.jsonl`). 읽기 전용 지킴, JSON 보고, 사용량 이벤트 있음.
  - 주의: 입력 토큰 75,764(캐시 59,392). Codex가 회사 폴더에도 기본 스킬(`skills\.system`: imagegen, openai-docs, review-agent, skill-creator 등)과 원격 플러그인 캐시(`plugins\cache\openai-curated-remote`)를 스스로 깔았다. 리뷰어 프롬프트에 섞이는지, 설정으로 끌 수 있는지 따로 확인할 것.
  - 확인함(10:07): `codex debug prompt-input`(토큰 안 씀)으로 보니 섞인다. 개발자 메시지에 `<skills_instructions>`(스킬 목록, 약 2,000자)와 `<recommended_plugins>`(Gmail·Slack·GitHub 등 16개)가 붙었다. 끄는 설정(`codex features list`와 0.163.0 실행 파일에서 찾음):
    - `[skills] include_instructions = false`, `[skills.bundled] enabled = false` → 스킬 목록 없어짐 (둘 다 각각으로도 없어짐)
    - `[features] plugins = false`, `remote_plugin = false`, `apps = false`, `tool_suggest = false` → 추천 플러그인 없어짐 (넷 다 각각으로도 없어짐)
    - 오케스트레이터의 `CODEX_HOME_CONFIG`에 넣고, 예전에 만든 설정은 `ensureCodexHome`이 새로 바꾼다. 실행할 때 `-c`로도 넘겨 설정 파일이 바뀌어도 꺼져 있다.
    - 다시 돌린 결과 **입력 토큰 75,764 → 42,290** (캐시 59,392 → 27,264, 출력 363, 16초, `stage0\out\codex-events-20261019-100717.jsonl`). 두 번 다 명령 4번·메시지 2개로 같은 모양이라 비교할 만하다. 읽기 전용·JSON 보고 그대로 통과.
    - `skills\.system`, `plugins\cache` 폴더 자체는 그대로 남아 있지만 프롬프트에는 안 들어간다.
- `codex exec --help`에 웹 검색 옵션: 없음 (search/web이 들어간 줄 0개). 다만 모델 정보에 `supports_search_tool: true`가 있어 설정으로 켤 수는 있다. 회사 전용 CODEX_HOME 설정에는 넣지 않았다.
- 메모 (실패와 고친 것 순서대로):
  1. 16:35 저장된 로그인 토큰을 새로 고치지 못함(401) → 주인이 다시 로그인.
  2. 18:03 주인의 Codex 앱 설정(`~/.codex/config.toml`)의 `model = "gpt-5.4"`를 CLI도 읽는데, ChatGPT 계정에서는 "지원하지 않는 모델"(400). 이 계정 목록(`models_cache.json`): gpt-6-luna, gpt-5.6-terra, gpt-5.6-luna(+숨김 gpt-reserve, codex-auto-review).
  3. 같은 설정에 컴퓨터 사용·브라우저·Chrome 플러그인과 MCP 서버가 켜져 있다. 리뷰어가 이것을 물려받지 않게 오케스트레이터는 **회사 전용 CODEX_HOME**(`C:\ai-office\data\codex-home`, 플러그인·MCP·모델 지정 없음)을 쓴다. **여기에 따로 로그인이 필요하다(주인 할 일)**. 이번 #6은 그 전이라 주인 로그인 + `-Model gpt-6-luna`로 확인했다.
  4. 22:58 Windows 샌드박스(elevated)에서 명령이 `-C` 폴더가 아니라 `C:\`에서 돌았다. 상대 경로면 "C:\ 쓰기 거부"와 "샌드박스 차단"을 구분할 수 없어 시험 문구를 절대 경로로 바꿔 다시 돌렸다(23:07, 위 결과). 어댑터도 작업 폴더를 절대 경로로 알려 주게 고쳤다.

## 어댑터 실제 확인 (npm run smoke, 2026-10-17)

```
[통과] Claude Code (읽기 전용, 샌드박스): 5.0초, 토큰 6430+97, 구조화 출력 맞음   (stage0\out\smoke-claude-20261017-215834.txt)
[통과] Codex (read-only, 샌드박스): 7.5초, 토큰 15878+47, 구조화 출력 맞음        (stage0\out\smoke-codex-20261017-223603.txt)
```

- 오케스트레이터 어댑터 그대로(개인 설정 분리 옵션, stream-json, Codex 작업 폴더 안내 포함) 실제 CLI로 돌린 결과.
- Codex는 회사 전용 CODEX_HOME 로그인 전이라 주인 로그인(`~/.codex`)과 `gpt-6-luna`로 확인했다. 주인 설정의 플러그인·MCP가 같이 올라가 토큰이 더 나왔다. 회사 전용 로그인 뒤 다시 확인한다.
- Ollama(로컬 모델)는 디스크가 모자라 모델을 받지 못해 아직 확인하지 않았다.

### 2026-10-19: 로컬 모델 포함, 지시 하나 끝까지 (`npm run smoke -- --flow`, 메모리 DB·임시 저장소)

- 두뇌 다섯 가지 연결 모두 통과: Qwen 0.7초, Gemma 7.5초, Qwen 재교체 6.6초, Claude Code 4.7초(6511+97), Codex 7.6초(14135+25, 회사 CODEX_HOME).
- 계획: PM(Qwen) 계획서 v1·v2가 GPT 관문에서 revise, v3는 반대 의견을 달아 CEO에게(설계대로). 시험이라 스크립트가 대신 승인.
- **작업: 티켓 3개 모두 `paused(cap)`** (반려 0). 개발자(Claude Code) 호출 한 번이 입력 40~51k토큰으로 잡혀 티켓 토큰 상한(PM 예상치×2, 최소 2만)을 첫 호출에 넘었다.
  입력 토큰에 캐시 읽기(Claude Code 기본 문맥, 대부분 캐시)가 들어가 있어서다. 상한 계산 방법을 정해야 한다(AUTONOMOUS-LOG 참고).
- 출력: `stage0\out\smoke-flow-20261019.txt` (PowerShell 리디렉션이라 UTF-16, 한글 일부 깨짐)

## #1 헤르메스 도구 호출 (2026-10-19 20:01~20:03, 실제 회사 MCP로)

**통과 (처음 5개 중 4개, 과제 4를 고친 뒤 재시험 통과로 5개 모두).** 가짜 MCP(mock-mcp.mjs) 대신 실제 회사 MCP `office`에 연결한 채로 #비서실에서 보냈다.
채점은 헤르메스 `state.db`의 세션 `20261019_200104_288ffc72` 기록(도구 이름과 인자)으로 했다.

| # | 보낸 말 | 부른 도구와 인자 | 판정 | 헤르메스가 한 답 (짧게) |
| --- | --- | --- | --- | --- |
| 1 | 지금 회사 상황 알려줘 | `get_status` {} | 통과 | 진행 중·막힘·결재 대기 없음 |
| 2 | T-12 티켓 어떻게 되고 있어? | `get_ticket` {ticketId: "T-12"} | 통과 | T-12 티켓을 찾을 수 없음 (실제로 없음) |
| 3 | 결재 기다리는 거 뭐 있어? | `get_pending_approvals` {} | 통과 | 결재 대기 없음 |
| 4 | 로그인 페이지에 비밀번호 찾기 기능 추가해줘 | `create_order` {rawText: 원문, discordMessageId: "current_message_id"} → 형식 검사에서 거부, 실행 안 됨 | **실패** → 고친 뒤 재시험 통과 (아래) | 메시지 ID를 몰라 등록 실패, ID를 알려 달라고 함 |
| 5 | T-12 main에 push해 | `request_confirmation` {kind: "push", targetId: "T-12"} → reason 빠져 거부 → 다시 {…, reason} | 통과 (재시도 1회) | T-12가 없어 푸시 요청 불가 |

- 헤르메스 버전: 패키지 버전 표기 0.0.0 (Windows 네이티브 설치, 2026-10-19)
- 두뇌: `gemma4:12b-64k` (num_ctx 65536 태그). 처음에는 `/v1`이 num_ctx를 무시해 4096으로 떠서 영어로 답하고 skills_list만 반복했다(DESIGN 6장 메모).
- 과제 4 실패 원인: **헤르메스는 Discord 메시지 ID를 저장(`platform_message_id`)하지만 모델에게 보여 주지 않는다.** 모델은 ID를 알 길이 없어 지어냈다. 체크리스트 원래 문장에는 "(Discord 메시지 ID: …)"가 붙어 있었는데 이번에는 빼고 보냈다. 실제 운영에서는 주인이 ID를 적지 않으므로 이 문제를 따로 풀어야 한다(18장 미결로 올림).
- **과제 4 재시험 (20:15, 통과)**: LINDA가 #비서실 주인 마지막 메시지 ID를 기록하고 `create_order`가 ID 없이 오면 그것을 쓰게 고친 뒤(DESIGN 6·9장), `/new` 후 다시 보냈다. `create_order`가 한 번에 성공해 지시 `O-1`이 실제 #비서실 메시지 ID(값은 공개 저장소에 적지 않음)로 등록됐다. 이것으로 **5개 모두 통과**.
  - 20:13에 한 번 더 보냈을 때는 실패했다. `/new` 없이 예전 대화에 이어 보내서다. 헤르메스는 대화를 시작할 때의 지침(SOUL.md)을 끝까지 쓰므로, SOUL.md를 바꾸면 게이트웨이 재시작과 `/new`가 둘 다 필요하다.
- 위험한 말(과제 5)을 `create_order`로 등록하지 않고 확인 버튼 요청으로 보낸 것은 맞다.
- 다섯 과제를 `/reset` 한 번 뒤 한 대화에서 보냈다(과제마다 새 대화가 원칙). 앞 과제의 영향이 있었을 수 있다.

## #7 헤르메스 Discord 연결

**통과.**

- [x] 메시지 수신·답장 됨 (#비서실, 멘션 없이)
- [x] 한국어 깨짐 없음 (SOUL.md 한국어 지침 적용 뒤)
- 답장까지 걸린 시간: 3~12초. 지시 등록처럼 생각이 긴 답은 40초대(생각 토큰 900~1,400개)
- 특정 사용자만 받는 설정: 있음 (`.env`의 `DISCORD_ALLOWED_USERS`, 주인만)
- 버튼 전송: 모름 (결재 버튼은 시스템 봇 LINDA가 보낸다)
- Discord에서 MCP 도구 호출: 됨 (#1 과제 모두 Discord에서 보냄)
- 메모: 64K 문맥에서 100% GPU. PM·검토 담당의 `gemma4:12b`(8K)와 다른 태그라 번갈아 쓰면 모델을 다시 올린다.

## #10 SearXNG (searxng-check.mjs)

```
(붙여 넣기)
```

- Docker Desktop 버전:
- 메모:

## #3 RAM 64GB · 저장공간 (ram-watch.ps1, env.ps1)

```
== 2026-10-19 10:50~ (stage0\out\ram-20261019-105044.csv, 5초 간격) ==
가장 적게 남은 RAM 39,390 MB / 63.8 GB · 커밋 최대 40,209 / 75,018 MB · 페이지 파일 최대 76 MB
프로세스 최대: claude 3,929 MB · node 1,164 MB · ollama 256 MB(모델은 VRAM) · codex 235 MB
```

- 모델을 받은 뒤 C: 여유 공간: **62 GB** (기준 60GB 이상, 두 모델 17.3GB 받은 뒤)
- 측정 중 띄운 것: 오케스트레이터(Discord 봇 연결), `smoke --flow`(Qwen·Gemma 교체, Claude Code 개발 3건, Codex 관문), Claude 데스크톱 앱
- 판정: **#3 통과**. 39GB 이상 늘 남았고 페이지 파일을 거의 쓰지 않았다(초당 페이지 순간 최대 1,664는 모델 파일 읽기).
- 메모: 헤르메스는 아직 설치 전이라 빠졌다. 헤르메스를 깐 뒤 한 번 더 재면 좋다. "claude" 수치에는 이 작업을 하는 Claude 데스크톱 앱도 들어 있다.
