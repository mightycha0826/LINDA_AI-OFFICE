# EmptyState

보여줄 목록이 아예 없을 때 화면 가운데에 둬요. 88px 회색 원 안에 아이콘 하나, 제목, 한 줄 안내.

- 빈 목록: point 아이콘(`checklist`). 입력줄이 있으면 버튼 없이 "아래 입력줄에 적으면 바로 추가돼요".
- 첫 로딩: `pt-empty--loading`, primary 아이콘(`progress_activity`).
- 저장본 없는 오프라인: `pt-empty--error`, 빨강 아이콘(`cloud_off`) + 보조 버튼 "다시 시도".
- 목록이 이미 있을 때는 쓰지 않아요. 그때는 `RefreshBar`나 `Toast`.
