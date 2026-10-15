# WeekStrip

달력 탭 맨 위의 한 주 날짜 줄이에요. 날짜를 누르면 아래 목록이 그날 할 일로 바뀌어요.

- 오늘: `aria-current="date"`, primary 테두리 2px와 `primary-text` 글자.
- 고른 날: `aria-pressed="true"`, `ink` 칸에 `bg` 글자. 오늘을 고르면 테두리 대신 칸이 보여요.
- 할 일이 있는 날: `has-task`, 숫자 아래 5px 점(`ink-muted`).
- 각 날은 72px 높이 버튼이고, `aria-label`에 날짜 전체와 "오늘"을 적어요.
