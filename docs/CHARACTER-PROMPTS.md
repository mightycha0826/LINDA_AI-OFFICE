# 캐릭터 그림 요청 프롬프트

이미지 생성 AI(ChatGPT 등)에 캐릭터 시트를 요청할 때 쓰는 문장이에요. 규격은 설계 13장을 따라요.

## 쓰는 순서

1. 캐릭터 기준 그림(얼굴이나 상반신 한 장)을 먼저 만들어요.
2. 같은 대화에서 기준 그림을 첨부하고 **A. 옆모습 시트**를 요청해요.
3. 이어서 **B. 정면 시트**를 요청해요. 옆모습 시트를 같이 첨부하면 얼굴과 옷이 더 잘 맞아요.
   정면 시트는 없어도 돼요. 없으면 화면은 오른쪽 그림으로 대신 보여 줘요.
4. 받은 PNG를 Claude Code에 주거나, 직접 잘라요.
   ```
   python scripts/slice-sprite-sheet.py <옆모습 시트> <캐릭터 ID>
   python scripts/slice-sprite-sheet.py <정면 시트> <캐릭터 ID> --front
   ```
   원본 시트는 `assets/sources/<캐릭터 ID>-sheet.webp`(정면은 `-front-sheet`)에 보관해요.

캐릭터 ID: `chief-of-staff`, `pm`, `developer`, `reviewer`, `marketing`, `strategy`, `qa-local`, `git-cat`, `temp-1`~`temp-4`.

**잘 안 될 때**
- 한 장에 다 그리면 품질이 떨어지면, 줄마다 따로 요청해요. 예: "row 3 only, 6 frames, 768 x 128 px".
- 다리가 잘려서 나오면(특히 blocked, paused) "FULL BODY, head to shoes visible"을 다시 강조해요.
- 배경은 흰색이어도 괜찮아요. 자르는 도구가 테두리에 이어진 흰 배경을 지워요.
  옷의 흰색이 배경과 맞닿으면 같이 지워질 수 있으니, 몸 둘레 외곽선은 꼭 그려 달라고 해요.

## 캐릭터 설명 칸 채우기

아래 프롬프트의 `[CHARACTER]` 자리에 영어로 1~2문장을 넣어요. 머리, 눈, 안경, 옷, 표정, 들고 다니는 물건 순서로 쓰면 돼요.

| ID | 예시 |
| --- | --- |
| chief-of-staff | a woman, black messy shoulder-length hair with bangs, yellow eyes, thin rectangular glasses, small mole under the left eye, black suit jacket, white shirt, black tie, calm slight smile |
| developer | (예) a young man, short brown hair, hoodie over a T-shirt, headphones around the neck |
| git-cat | 아래 "고양이" 변형을 써요 |

## A. 옆모습 시트 (오른쪽 방향)

```
Attached is my character reference. Character: [CHARACTER]
Turn this character into a game sprite sheet for a virtual office.

STYLE
- Flat illustration, clean dark outline around the whole body, minimal shading, same colors as the reference.
- FULL BODY in every frame (head to shoes visible), chibi proportions about 2.5 heads tall, readable when shrunk to 64x64 px.
- Facing RIGHT (side / 3-quarter view) in every frame.
- Plain white or transparent background. No floor, no shadow, no text, no name tag, no speech bubbles, no icons, no "!" or "Zzz". Only the character's body and motion (plus the props listed below).

GRID
- One image, 768 x 896 px: 6 columns x 7 rows of 128 x 128 px cells. Clear empty space between frames; frames must not touch each other.
- Every frame: same size and scale, centered in its cell, feet on the same baseline (feet center at x=64, y=120 in the cell). Unused cells stay empty.
- Rows, top to bottom (frames start from the left):
  1. idle - 2 frames: standing, subtle breathing
  2. typing - 2 frames: seated on an office chair, typing on a small keyboard, alternate hand positions
  3. walking - 6 frames: walk cycle to the right, smooth loop
  4. carrying - 6 frames: same walk cycle while holding a plain brown cardboard box in both arms (no writing on it)
  5. meeting - 2 frames: seated on an office chair, listening, small nod between frames
  6. blocked - 2 frames: standing, hand on forehead, troubled expression
  7. paused - 1 frame: standing still, eyes closed, relaxed
- The character's design, outfit and colors must be identical in all 21 frames.
```

## B. 정면 시트

```
Same character, same style and same scale as the attached side-view sprite sheet. Character: [CHARACTER]
Now draw the FRONT VIEW (facing the viewer).

STYLE
- Flat illustration, clean dark outline around the whole body, minimal shading, identical colors and outfit.
- FULL BODY in every frame (head to shoes visible), chibi proportions about 2.5 heads tall.
- Facing the viewer (front view, symmetrical) in every frame.
- Plain white or transparent background. No floor, no shadow, no text, no name tag, no speech bubbles, no icons, no "!" or "Zzz".

GRID
- One image, 768 x 896 px: 6 columns x 7 rows of 128 x 128 px cells. Clear empty space between frames; frames must not touch each other.
- Every frame: same size and scale as the side-view sheet, centered in its cell, feet on the same baseline (feet center at x=64, y=120). Unused cells stay empty.
- Rows, top to bottom (frames start from the left):
  1. idle - 2 frames: standing facing the viewer, subtle breathing
  2. typing - 2 frames: seated on an office chair facing the viewer, typing on a small keyboard on the lap, alternate hand positions
  3. walking - 6 frames: walking TOWARD the viewer, smooth loop (legs alternate, arms swing)
  4. carrying - 6 frames: walking toward the viewer holding a plain brown cardboard box in both arms
  5. meeting - 2 frames: seated facing the viewer, listening, small nod between frames
  6. blocked - 2 frames: standing, hand on forehead, troubled expression
  7. paused - 1 frame: standing still, eyes closed, relaxed
- The character's design, outfit and colors must be identical in all 21 frames and match the side-view sheet.
```

## 고양이 변형 (git-cat)

옥토캣(GitHub 마스코트)과 겹치지 않는 우리만의 고양이예요(13장). A와 B 프롬프트에서 아래만 바꿔요.

- `Character:` 자리: `[색·무늬], an ordinary four-legged cat, NOT the GitHub Octocat (no tentacles, no human body)`
- 비율 문장: `chibi proportions about 2.5 heads tall` 대신 `cute cat proportions, four legs, about 70 px tall inside the 128 px cell`
- typing: `sitting at a tiny keyboard, tapping it with front paws`
- carrying: `walking while carrying a small plain cardboard box on its back`
- meeting: `sitting upright, ears up, listening`
- blocked: `sitting, one paw over its eyes`
- paused: `curled up asleep`

## 비서실장 (chief-of-staff) 지금 할 것

옆모습 시트는 이미 들어가 있어요. 아래 둘만 요청하면 돼요.

1. 위 **B. 정면 시트**를 chief-of-staff 설명으로 요청해요. 지금 옆모습 시트를 첨부하세요.
2. 옆모습 blocked와 paused는 허리 아래가 잘려서 들어갔어요. 아래 문장으로 다시 요청해요.

```
Same character, same style and scale as the attached sprite sheet. Redraw only these rows as FULL BODY (head to shoes visible), facing right, white background, 128 x 128 px cells, feet at the bottom of each cell:
row 1: blocked - 2 frames, standing, hand on forehead, troubled expression
row 2: paused - 1 frame, standing still, eyes closed, relaxed
```
