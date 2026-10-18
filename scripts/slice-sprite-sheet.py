#!/usr/bin/env python
# 이미지 생성 AI가 만든 스프라이트 시트를 13장 규격 PNG로 자른다.
#   python scripts/slice-sprite-sheet.py <시트 이미지> <캐릭터 ID>            옆모습(오른쪽) 시트
#   python scripts/slice-sprite-sheet.py <시트 이미지> <캐릭터 ID> --front    정면 시트 → <동작>-front.png
# 정면 시트는 줄 순서가 같고, walking·carrying은 화면 쪽(아래)으로 걸어오는 모습. 기존 manifest에 합친다.
# 시트: 흰 배경, 위에서부터 idle 2, typing 2, walking 6, carrying 6, meeting 2, blocked 2, paused 1 (줄마다 왼쪽부터).
# 칸 크기가 정확하지 않아도 된다: 그림 덩어리를 찾아 자르고, 흰 배경을 지우고,
# 모든 프레임을 같은 배율로 줄여 발(가장 아래 픽셀)을 y 120, 머리 중심을 동작마다 같은 x에 맞춘다.
# 필요한 것: Pillow, numpy, scipy.
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

F = 128
ANCHOR_X, ANCHOR_Y = 64, 120
MAX_H = 116  # 가장 큰 프레임의 높이(px). 머리 위 여백 4px
POSES = [
    ('idle', 2, 2, True),
    ('typing', 2, 6, True),
    ('walking', 6, 10, True),
    ('carrying', 6, 10, True),
    ('meeting', 2, 2, True),
    ('blocked', 2, 3, True),
    ('paused', 1, 1, False),
]
WHITE = 236  # 이보다 밝은 무채색은 배경 후보


def gaps(profile, min_gap):
    """profile이 0인 구간으로 나눈 [시작, 끝) 목록."""
    on = profile > 0
    spans, start, blank = [], None, 0
    for i, v in enumerate(on):
        if v:
            if start is None:
                start = i
            blank = 0
        elif start is not None:
            blank += 1
            if blank >= min_gap:
                spans.append((start, i - blank + 1))
                start, blank = None, 0
    if start is not None:
        spans.append((start, len(on) - blank))
    return spans


def split_to(profile, spans, want, margin):
    """덩어리가 모자라면 가장 큰 덩어리를 가운데쯤 가장 얇은 곳에서 나눈다 (머리카락이 닿은 경우)."""
    spans = list(spans)
    while len(spans) < want:
        i = max(range(len(spans)), key=lambda k: spans[k][1] - spans[k][0])
        a, b = spans[i]
        if b - a < margin * 3:
            break
        cut = a + margin + int(np.argmin(profile[a + margin:b - margin]))
        spans[i:i + 1] = [(a, cut), (cut + 1, b)]
    return spans


def cut_background(rgba):
    """테두리에서 이어진 밝은 배경만 투명하게 (셔츠 같은 안쪽 흰색은 남김). 가장자리는 반투명."""
    rgb = rgba[..., :3].astype(np.int16)
    light = (rgb.min(axis=2) >= WHITE) & ((rgb.max(axis=2) - rgb.min(axis=2)) < 18)
    light |= rgba[..., 3] < 16
    labels, _ = ndimage.label(light)
    border = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    bg = np.isin(labels, border[border > 0])
    out = rgba.copy()
    out[..., 3] = np.where(bg, 0, out[..., 3])
    # 배경과 맞닿은 밝은 테두리 픽셀은 밝기만큼 투명하게 (흰 테두리 줄이기)
    edge = ndimage.binary_dilation(bg) & ~bg
    lum = rgb.mean(axis=2)
    soft = np.clip((255 - lum) / (255 - 170), 0, 1)
    out[..., 3] = np.where(edge, (out[..., 3] * soft).astype(np.uint8), out[..., 3])
    return out


def main():
    src, char_id = Path(sys.argv[1]), sys.argv[2]
    suffix = '-front' if '--front' in sys.argv[3:] else ''
    sheet = np.array(Image.open(src).convert('RGBA'))
    rgb = sheet[..., :3].astype(np.int16)
    ink = (rgb.min(axis=2) < WHITE - 6) & (sheet[..., 3] > 16)
    ink = ndimage.binary_opening(ink, iterations=1)  # 점 같은 잡티 제거

    rp = ink.sum(axis=1)
    rows = split_to(rp, [r for r in gaps(rp, 1) if r[1] - r[0] > 40], len(POSES), 80)
    if len(rows) != len(POSES):
        sys.exit(f'줄을 {len(rows)}개 찾았어요. {len(POSES)}개여야 해요: {rows}')

    frames = {}
    for (name, count, _, _), (y0, y1) in zip(POSES, rows):
        cp = ink[y0:y1].sum(axis=0)
        cols = split_to(cp, [c for c in gaps(cp, 4) if c[1] - c[0] > 30], count, 50)
        if len(cols) != count:
            sys.exit(f'{name}: 프레임 {len(cols)}개를 찾았어요. {count}개여야 해요: {cols}')
        frames[name] = []
        for x0, x1 in cols:
            pad = 6
            box = sheet[y0:y1, max(x0 - pad, 0):x1 + pad]
            cut = cut_background(box)
            # 옆 줄 머리카락 끝 같은 작은 조각은 버린다
            labels, n = ndimage.label(ndimage.binary_dilation(cut[..., 3] > 24, iterations=2))
            if n > 1:
                sizes = ndimage.sum(np.ones_like(labels), labels, range(1, n + 1))
                keep = np.isin(labels, 1 + np.nonzero(sizes >= sizes.max() * 0.03)[0])
                cut[..., 3] = np.where(keep, cut[..., 3], 0)
            ys, xs = np.nonzero(cut[..., 3] > 24)
            frames[name].append(cut[ys.min():ys.max() + 1, xs.min():xs.max() + 1])

    scale = MAX_H / max(f.shape[0] for fs in frames.values() for f in fs)
    out_dir = Path(__file__).resolve().parent.parent / 'assets' / 'characters' / char_id
    out_dir.mkdir(parents=True, exist_ok=True)
    mpath = out_dir / 'manifest.json'
    manifest = {'id': char_id, 'frame': {'width': F, 'height': F}, 'anchor': {'x': ANCHOR_X, 'y': ANCHOR_Y}, 'poses': {}}
    if mpath.exists():
        manifest['poses'] = json.loads(mpath.read_text(encoding='utf-8')).get('poses', {})

    for name, count, fps, loop in POSES:
        small = []
        for f in frames[name]:
            h, w = f.shape[:2]
            im = Image.fromarray(f).resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
            a = np.array(im)[..., 3] > 40
            top = a[: max(1, a.shape[0] * 2 // 5)]  # 위 40% = 머리
            head_x = np.nonzero(top)[1].mean()
            small.append((im, head_x))
        # 머리 중심을 동작 안에서 같은 x로, 그다음 동작 전체를 가운데로
        lefts = [-hx for _, hx in small]
        rights = [im.width - hx for im, hx in small]
        head = ANCHOR_X - (min(lefts) + max(rights)) / 2
        strip = Image.new('RGBA', (F * count, F), (0, 0, 0, 0))
        for i, (im, hx) in enumerate(small):
            x = round(i * F + head - hx)
            y = ANCHOR_Y - im.height
            x = min(max(x, i * F), i * F + F - im.width)  # 칸 밖으로 나가지 않게
            strip.alpha_composite(im, (x, max(y, 0)))
        key = name + suffix
        strip.save(out_dir / f'{key}.png')
        manifest['poses'][key] = {'file': f'{key}.png', 'frames': count, 'fps': fps, 'loop': loop}

    mpath.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(f'배율 {scale:.3f}, {out_dir}')


if __name__ == '__main__':
    main()
