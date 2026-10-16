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
(붙여 넣기)
```

- 메모: 2026-10-16 16:34 첫 시도는 로그인 확인에서 멈춤. `claude auth status`가 loggedIn: false, authMethod: none (ANTHROPIC_API_KEY 없음). CLI에서 `claude auth login` 후 다시.

## #5 Claude 사용량 읽기

- claude-headless.ps1의 사용량 부분:

```
(붙여 넣기)
```

- 상태줄에 5h·7d %가 떴는가: 예 / 아니오
- 상태줄 값과 claude.ai 사용량 화면 값: 상태줄 5h ___% / 화면 ___%, 상태줄 7d ___% / 화면 ___%
- 메모:

## #6 Codex 자동 실행 (codex-readonly.ps1)

```
== 요약 == (2026-10-16 16:35 첫 시도, stage0\out\codex-*-20261016-163529.*)
[실패] 자동 실행 또는 JSON 출력 실패 (종료 코드 1)
[통과] 읽기 전용: target.txt 그대로, new.txt 없음
[확인 필요] 이벤트에 토큰 사용량이 없음
```

- `codex exec --help`에 웹 검색 옵션: 없음 (search/web이 들어간 줄 0개, codex-cli 0.163.0)
- 메모: 실패 원인은 로그인. `codex login status`는 "Logged in using ChatGPT"였지만 저장된 토큰을 새로 고치지 못함("Please log out and sign in again"), 서버 401. 기본 모델 gpt-5.4의 메타데이터가 없다는 경고도 있음. `codex logout` → `codex login` 후 다시. 읽기 전용 차단은 이 실행에서도 지켜짐.

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
