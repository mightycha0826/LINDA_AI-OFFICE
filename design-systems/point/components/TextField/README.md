# TextField

라벨이 위에 붙는 입력창이에요. 테두리 없이 `row` 면으로 구분해요.

- 포커스: 안쪽 2px `focus` 테두리.
- 오류: `aria-invalid="true"` + 안쪽 2px `danger-line` 테두리, 아래에 느낌표 아이콘과 `danger-on-bg` 문구. 문구는 `aria-describedby`로 연결.
- 라벨은 `text-caption`(13px, 700, `ink-muted`).
