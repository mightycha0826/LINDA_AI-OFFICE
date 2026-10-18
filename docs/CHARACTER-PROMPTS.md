# 캐릭터 그림 요청 프롬프트

이미지 생성 AI(ChatGPT 등)에 캐릭터 시트를 요청할 때 쓰는 문장이에요. 규격은 설계 13장을 따라요.
새 캐릭터는 **옆모습과 정면이 한 장에 들어간 시트**(투명 배경) 하나로 만들어요.

## 쓰는 순서

1. 캐릭터 기준 그림(얼굴이나 상반신 한 장)을 먼저 만들어요.
2. 같은 대화에서 기준 그림을 첨부하고 아래 **캐릭터 시트 프롬프트**를 보내요. `[CHARACTER]` 자리는 채워서 보내요.
3. 받은 PNG를 Claude Code에 주거나, 직접 잘라요.
   ```
   python scripts/slice-sprite-sheet.py <시트 PNG> <캐릭터 ID> --both
   ```
   원본 시트는 `assets/sources/<캐릭터 ID>-sheet.png`에 보관해요.

캐릭터 ID: `chief-of-staff`, `pm`, `developer`, `reviewer`, `marketing`, `strategy`, `qa-local`, `git-cat`, `temp-1`~`temp-4`.

## 캐릭터 설명 칸 채우기

`[CHARACTER]` 자리에 영어로 1~2문장을 넣어요. 머리, 눈, 안경, 옷, 표정, 들고 다니는 물건 순서로 쓰면 돼요.

| ID | 예시 |
| --- | --- |
| chief-of-staff | a woman, black messy shoulder-length hair with bangs, yellow eyes, thin rectangular glasses, small mole under the left eye, black suit jacket, white shirt, black tie, calm slight smile |
| developer | (예) a young man, short brown hair, gray hoodie over a T-shirt, headphones around the neck |
| git-cat | 아래 "고양이 변형"을 써요 |

## 캐릭터 시트 프롬프트 (옆모습 + 정면, 투명 배경)

```
Attached is my character reference. Character: [CHARACTER]
Make ONE game sprite sheet of this character for a virtual office, with both SIDE VIEW and FRONT VIEW.

BACKGROUND
- Real transparent background (PNG with alpha channel). NOT white, NOT a gray-and-white checkerboard pattern.
- No floor, no shadow, no text, no labels, no grid lines, no name tag, no speech bubbles, no icons, no "!" or "Zzz".

STYLE
- Flat illustration, clean dark outline around the whole body, minimal shading, same colors as the reference.
- FULL BODY in every frame (head to shoes visible), chibi proportions about 2.5 heads tall, readable when shrunk to 64x64 px.
- Same character design, outfit, colors and size in every frame.

GRID
- Image size 1536 x 1024 px = 12 columns x 8 rows of 128 x 128 px cells. Row 8 stays empty.
- Each frame sits inside its own cell, centered, with clear empty space around it; frames never touch each other.
- Feet on the same baseline in every cell (feet center at x=64, y=120 inside the cell). Same scale in every frame.
- In every row: columns 1-6 = SIDE VIEW facing RIGHT, columns 7-12 = FRONT VIEW facing the viewer. Start each group from its first column; leave unused cells empty.

ROWS (side frames | front frames)
1. idle - 2 | 2: standing, subtle breathing
2. typing - 2 | 2: seated on an office chair typing on a small keyboard, alternate hand positions (front: keyboard on the lap)
3. walking - 6 | 6: walk cycle, smooth loop (side: walking to the right; front: walking TOWARD the viewer)
4. carrying - 6 | 6: same walk cycle holding a plain brown cardboard box in both arms (no writing on it)
5. meeting - 2 | 2: seated on an office chair, listening, small nod between frames
6. blocked - 2 | 2: standing, hand on forehead, troubled expression
7. paused - 1 | 1: standing still, eyes closed, relaxed
```

## 잘 안 나올 때

- **배경이 흰색이나 체크무늬로 나오면** "Make the background truly transparent (alpha channel), not a drawn checkerboard"라고 다시 요청해요.
  끝까지 안 되면 그대로 보내도 돼요. 자르는 도구가 흰색과 체크무늬 배경을 지워요.
  다만 머리카락 사이에 갇힌 배경은 남을 수 있어서, 투명 배경이 가장 깔끔해요.
- **한 장에 다 그려서 품질이 떨어지면** 옆모습과 정면을 따로 요청해요. 각각 768 x 1024 px(6열 x 8줄)로 하고, ROWS에서 한쪽만 남기면 돼요.
  자를 때는 옆모습은 `--both` 없이, 정면은 `--front`를 붙여요.
- **다리가 잘려서 나오면**(특히 blocked, paused) "FULL BODY, head to shoes visible"을 다시 강조해요.
- **프레임 수가 틀리면** 그 줄만 다시 요청해요. 예: "redraw row 3 only: 6 side frames + 6 front frames, same grid".

## 고양이 변형 (git-cat)

옥토캣(GitHub 마스코트)과 겹치지 않는 우리만의 고양이예요(13장). 프롬프트에서 아래만 바꿔요.

- `Character:` 자리: `[색·무늬], an ordinary four-legged cat, NOT the GitHub Octocat (no tentacles, no human body)`
- 비율 문장: `chibi proportions about 2.5 heads tall` 대신 `cute cat proportions, four legs, about 70 px tall inside the 128 px cell`
- typing: `sitting at a tiny keyboard, tapping it with front paws`
- carrying: `walking while carrying a small plain cardboard box on its back`
- meeting: `sitting upright, ears up, listening`
- blocked: `sitting, one paw over its eyes`
- paused: `curled up asleep`

## 이미 들어간 캐릭터

- chief-of-staff: 옆모습(`assets/sources/chief-of-staff-sheet.webp`)과 정면(`chief-of-staff-front-sheet.webp`)을 따로 받아서 넣었어요.
  정면 시트는 흰 배경이라 머리카락 사이에 흰 틈이 조금 남아 있어요. 위 프롬프트로 투명 배경 시트를 다시 받으면 깔끔해져요.
