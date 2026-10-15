# Button

글자 버튼은 세 가지예요: 주 버튼(primary), 보조 버튼(회색 면), 삭제 버튼(회색 면에 빨간 글자).

- 한 화면에 주 버튼은 하나. 나머지는 보조 버튼.
- 삭제는 빨간 면을 쓰지 않아요. 회색 면에 `danger` 글자.
- 상태: 호버 8%, 눌림 16% + `scale(.96)`, 포커스 테두리, 비활성 0.4. 미리보기용으로 `is-hover`·`is-active`·`is-focus` 클래스가 있어요.
- 로딩은 `is-loading` + `progress_activity` 아이콘 + "저장 중".
- 화면 아래 꽉 찬 버튼은 `pt-btn--block`(높이 56px).

```html
<button class="pt-btn pt-btn--primary"><span class="material-symbols-rounded" aria-hidden="true">add</span>추가</button>
<button class="pt-btn">취소</button>
<button class="pt-btn pt-btn--danger"><span class="material-symbols-rounded" aria-hidden="true">delete</span>삭제</button>
```
