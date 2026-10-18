#!/usr/bin/env python
# 이미지 생성 AI가 만든 스프라이트 시트를 13장 규격 PNG로 자른다.
#   python scripts/slice-sprite-sheet.py <시트> <캐릭터 ID> --both     옆모습+정면 한 장 (새 캐릭터 기본, docs/CHARACTER-PROMPTS.md)
#   python scripts/slice-sprite-sheet.py <시트> <캐릭터 ID>            옆모습(오른쪽)만 있는 시트
#   python scripts/slice-sprite-sheet.py <시트> <캐릭터 ID> --front    정면만 있는 시트 → <동작>-front.png (옆모습 idle 키에 맞춤)
# 시트 줄 순서: idle 2, typing 2, walking 6, carrying 6, meeting 2, blocked 2, paused 1 (줄마다 왼쪽부터).
# --both 는 시트 왼쪽 절반이 옆모습, 오른쪽 절반이 정면 (정면 walking·carrying은 화면 쪽으로 걸어옴).
# 칸 크기가 정확하지 않아도 된다: 그림 덩어리를 찾아 자르고, 배경(투명, 흰색, 가짜 투명 체크무늬)을 지우고,
# 모든 프레임을 같은 배율로 줄여 발(가장 아래 픽셀)을 y 120, 머리 중심을 동작마다 같은 x에 맞춘다. 기존 manifest에 합친다.
# 필요한 것: Pillow, numpy, scipy.
import json
import sys
from collections import Counter
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
BG_TOL = 20  # 배경색과 이만큼(채널별) 가까우면 배경 후보


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


def bg_palette(sheet):
    """시트 테두리에서 배경색을 찾는다. 흰색 한 가지, 또는 가짜 투명 체크무늬의 두 색. 진짜 투명이면 빈 목록."""
    edge = np.concatenate([sheet[:4].reshape(-1, 4), sheet[-4:].reshape(-1, 4), sheet[:, :4].reshape(-1, 4), sheet[:, -4:].reshape(-1, 4)])
    solid = edge[edge[:, 3] > 200]
    if len(solid) < len(edge) * 0.5:
        return np.zeros((0, 3), np.int16)  # 테두리 대부분이 투명 = 진짜 투명 배경
    edge = solid
    counts = Counter(map(tuple, (edge[:, :3] // 8 * 8 + 4).tolist()))
    pal, total = [], 0
    for color, n in counts.most_common(6):
        pal.append(color)
        total += n
        if total >= len(edge) * 0.9:
            break
    return np.array(pal, np.int16)


def bg_like(rgba, pal):
    near = rgba[..., 3] < 16
    rgb = rgba[..., :3].astype(np.int16)
    for c in pal:
        near |= np.abs(rgb - c).max(axis=2) <= BG_TOL
    return near


def cut_background(rgba, pal):
    """테두리에서 이어진 배경만 투명하게 (셔츠 같은 안쪽 흰색은 남김). 밝은 배경이면 가장자리를 반투명."""
    labels, _ = ndimage.label(bg_like(rgba, pal))
    border = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    bg = np.isin(labels, border[border > 0])
    out = rgba.copy()
    out[..., 3] = np.where(bg, 0, out[..., 3])
    if len(pal) and pal.mean() > 180:
        # 배경과 맞닿은 3px 띠에서 흰 배경이 섞인 만큼 걷어 낸다 (머리카락 둘레 흰 테두리 없애기).
        # 픽셀 = a·그림 + (1-a)·흰색 으로 보고, 그림 쪽 밝기를 60으로 가정해 a를 구한 뒤 색에서 흰색을 뺀다.
        band = ndimage.binary_dilation(bg, iterations=3) & ~bg
        rgb = rgba[..., :3].astype(np.float32)
        lum = rgb.mean(axis=2)
        a = np.clip((255 - lum) / (255 - 60), 0, 1)
        fg = np.clip((rgb - (1 - a[..., None]) * 255) / np.maximum(a[..., None], 1e-3), 0, 255)
        out[..., :3] = np.where(band[..., None] & (a[..., None] > 0), fg, rgb).astype(np.uint8)
        out[..., 3] = np.where(band, (out[..., 3] * a).astype(np.uint8), out[..., 3])
    return out


def find_frames(sheet, per_row, halves=False):
    """줄마다 그림 덩어리를 잘라 배경을 지운 RGBA 목록으로. halves면 줄마다 [왼쪽 절반, 오른쪽 절반] 두 묶음.
    덩어리가 기대보다 적으면 붙은 곳을 나누고, 많으면 찾은 대로 쓴다 (걷기 7프레임 같은 경우. manifest 프레임 수도 따라감)."""
    pal = bg_palette(sheet)
    ink = ndimage.binary_opening(~bg_like(sheet, pal), iterations=1)  # 점 같은 잡티 제거
    rp = ink.sum(axis=1)
    rows = split_to(rp, [r for r in gaps(rp, 1) if r[1] - r[0] > 40], len(per_row), 80)
    if len(rows) != len(per_row):
        sys.exit(f'줄을 {len(rows)}개 찾았어요. {len(per_row)}개여야 해요: {rows}')
    mid = sheet.shape[1] // 2
    out = []
    for (name, _, _, _), want, (y0, y1) in zip(POSES, per_row, rows):
        cp = ink[y0:y1].sum(axis=0)
        spans = [c for c in gaps(cp, 4) if c[1] - c[0] > 30]
        groups = [[c for c in spans if (c[0] + c[1]) / 2 < mid], [c for c in spans if (c[0] + c[1]) / 2 >= mid]] if halves else [spans]
        row = []
        for gi, cols in enumerate(groups):
            label = name + ('-front' if gi == 1 else '')
            cols = split_to(cp, cols, want, 40)
            if not cols:
                sys.exit(f'{label}: 그림을 못 찾았어요')
            if len(cols) != want:
                print(f'  알림: {label} 프레임 {len(cols)}개 (규격 {want}개). 찾은 대로 써요')
            frames = []
            for x0, x1 in cols:
                pad = 6
                cut = cut_background(sheet[y0:y1, max(x0 - pad, 0):x1 + pad], pal)
                # 옆 줄 머리카락 끝 같은 작은 조각은 버린다
                labels, n = ndimage.label(ndimage.binary_dilation(cut[..., 3] > 24, iterations=2))
                if n > 1:
                    sizes = ndimage.sum(np.ones_like(labels), labels, range(1, n + 1))
                    keep = np.isin(labels, 1 + np.nonzero(sizes >= sizes.max() * 0.03)[0])
                    cut[..., 3] = np.where(keep, cut[..., 3], 0)
                ys, xs = np.nonzero(cut[..., 3] > 24)
                frames.append(cut[ys.min():ys.max() + 1, xs.min():xs.max() + 1])
            row.append(frames)
        out.append(row)
    return out


def write_strip(frames, scale, path):
    small = []
    for f in frames:
        h, w = f.shape[:2]
        im = Image.fromarray(f).resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
        a = np.array(im)[..., 3] > 40
        top = a[: max(1, a.shape[0] * 2 // 5)]  # 위 40% = 머리
        small.append((im, np.nonzero(top)[1].mean()))
    # 머리 중심을 동작 안에서 같은 x로, 그다음 동작 전체를 가운데로
    lefts = [-hx for _, hx in small]
    rights = [im.width - hx for im, hx in small]
    head = ANCHOR_X - (min(lefts) + max(rights)) / 2
    strip = Image.new('RGBA', (F * len(frames), F), (0, 0, 0, 0))
    for i, (im, hx) in enumerate(small):
        x = min(max(round(i * F + head - hx), i * F), i * F + F - im.width)  # 칸 밖으로 나가지 않게
        strip.alpha_composite(im, (x, max(ANCHOR_Y - im.height, 0)))
    strip.save(path)


def main():
    src, char_id = Path(sys.argv[1]), sys.argv[2]
    mode = 'both' if '--both' in sys.argv[3:] else 'front' if '--front' in sys.argv[3:] else 'side'
    sheet = np.array(Image.open(src).convert('RGBA'))
    rows = find_frames(sheet, [count for _, count, _, _ in POSES], halves=mode == 'both')

    # 출력할 동작: (manifest 키, 프레임들, 동작 정보). --both 는 왼쪽 절반이 옆모습, 오른쪽 절반이 정면
    outs = []
    for (name, _, fps, loop), row in zip(POSES, rows):
        if mode == 'both':
            outs += [(name, row[0], fps, loop), (f'{name}-front', row[1], fps, loop)]
        else:
            outs.append((name + ('-front' if mode == 'front' else ''), row[0], fps, loop))

    scale = MAX_H / max(f.shape[0] for _, fs, _, _ in outs for f in fs)
    out_dir = Path(__file__).resolve().parent.parent / 'assets' / 'characters' / char_id
    side_idle = out_dir / 'idle.png'
    if mode == 'front' and side_idle.exists():
        # 정면은 옆모습 idle과 키가 같게 (시트마다 그린 크기가 달라도 화면에서 같은 사람으로 보이게)
        ys = np.nonzero(np.array(Image.open(side_idle))[:, :F, 3] > 24)[0]
        scale = min((ys.max() - ys.min() + 1) / rows[0][0][0].shape[0], scale * (ANCHOR_Y - 2) / MAX_H)

    out_dir.mkdir(parents=True, exist_ok=True)
    mpath = out_dir / 'manifest.json'
    manifest = {'id': char_id, 'frame': {'width': F, 'height': F}, 'anchor': {'x': ANCHOR_X, 'y': ANCHOR_Y}, 'poses': {}}
    if mpath.exists():
        manifest['poses'] = json.loads(mpath.read_text(encoding='utf-8')).get('poses', {})
    for key, frames, fps, loop in outs:
        write_strip(frames, scale, out_dir / f'{key}.png')
        manifest['poses'][key] = {'file': f'{key}.png', 'frames': len(frames), 'fps': fps, 'loop': loop}
    mpath.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(f'{mode}: 동작 {len(outs)}개, 배율 {scale:.3f}, {out_dir}')


if __name__ == '__main__':
    main()
