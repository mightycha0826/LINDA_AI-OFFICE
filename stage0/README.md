# stage0 — 0단계 위험한 가정 검증

연구실 PC에서 주인이 직접 돌린다. 순서와 통과 기준은 [CHECKLIST.md](CHECKLIST.md), 결과는 [RESULTS.md](RESULTS.md)에 적는다.

| 파일 | 항목 | 하는 일 |
| --- | --- | --- |
| `env.ps1` | 기준 정보 | OS·RAM·GPU·도구 버전·절전·자동 로그인 확인 |
| `network.ps1` | #8 | 대상별 DNS·TCP 443·TLS 발급자·HTTPS 응답 |
| `model-swap.mjs` | #2 | Qwen ↔ Gemma 교대 호출, 로드 시간 측정 |
| `claude-headless.ps1` | #4, #5 | worktree에서 `claude -p` 자동 실행, push 차단 확인, 사용량 필드 |
| `statusline-probe.mjs`, `statusline-settings.json` | #5 | 상태줄로 구독 사용량 % 읽기 |
| `codex-readonly.ps1` | #6 | `codex exec` 읽기 전용 실행, 파일이 바뀌지 않았는지 확인 |
| `mock-mcp.mjs` | #1 | 비서실장 MCP 도구 7개를 흉내 내는 가짜 서버, 호출 기록과 채점 |
| `ram-watch.ps1` | #3 | 메모리·페이지 파일을 CSV로 기록 |
| `searxng-check.mjs`, `searxng/settings.yml` | #10 | SearXNG JSON 검색과 127.0.0.1 한정 확인 (2.5단계에서 추가) |

- 스크립트는 읽기와 측정만 한다. 시스템 설정을 바꾸지 않는다.
- 테스트용 저장소는 `%TEMP%\ai-office-stage0\` 아래에 만든다.
- 결과 파일은 `stage0\out\`에 남고 git에는 올라가지 않는다.
- `.ps1` 파일은 Windows PowerShell 5.1에서 한글이 깨지지 않게 UTF-8 BOM으로 저장돼 있다. 편집기에서 저장할 때 BOM을 지우지 않는다.
