// 3D 인형 얼굴 그림 (13장 3D 캐릭터). 눈·눈썹·입·볼을 캔버스에 그려 머리 구에 입힌다.
// u = 0.25가 정면, 캔버스 오른쪽이 캐릭터의 왼쪽(+x). 색은 숫자로 적고 그릴 때만 문자열로 바꾼다 (17장 3D 예외)
import { shade, type Look } from './characters.ts';
import { css } from './util.ts';

const rgba = (n: number, a: number) => `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;

export function paintFace(look: Look): HTMLCanvasElement {
  const W = 1024;
  const H = 512;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const c = cv.getContext('2d')!;
  c.fillStyle = css(look.skin);
  c.fillRect(0, 0, W, H);
  const cx = W * 0.25;
  // 볼
  for (const s of [-1, 1]) {
    const g = c.createRadialGradient(cx + s * 70, 314, 2, cx + s * 70, 314, 30);
    g.addColorStop(0, rgba(0xee8080, 0.35));
    g.addColorStop(1, rgba(0xee8080, 0));
    c.fillStyle = g;
    c.beginPath();
    c.ellipse(cx + s * 70, 314, 32, 16, 0, 0, Math.PI * 2);
    c.fill();
  }
  // 눈썹
  c.strokeStyle = css(shade(look.hairShade, 0.1));
  c.lineCap = 'round';
  c.lineWidth = 4;
  for (const s of [-1, 1]) {
    c.beginPath();
    c.moveTo(cx + s * 30, 220);
    c.quadraticCurveTo(cx + s * 60, 207, cx + s * 92, 218);
    c.stroke();
  }
  for (const s of [-1, 1] as const) eye(c, cx + s * 60, 274, s, look);
  // 코 (작은 그늘)
  c.strokeStyle = css(shade(look.skin, -0.22));
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(cx + 2, 306);
  c.lineTo(cx - 1, 315);
  c.stroke();
  // 입
  const my = 338;
  if (look.smile) {
    c.fillStyle = css(0xe48f95);
    c.beginPath();
    c.moveTo(cx - 15, my);
    c.quadraticCurveTo(cx, my + 14, cx + 15, my);
    c.quadraticCurveTo(cx, my + 5, cx - 15, my);
    c.fill();
    c.strokeStyle = css(0xb4646a);
    c.lineWidth = 2.5;
    c.beginPath();
    c.moveTo(cx - 16, my - 1);
    c.quadraticCurveTo(cx, my + 8, cx + 16, my - 1);
    c.stroke();
  } else {
    c.fillStyle = css(0xe99ea2);
    c.beginPath();
    c.ellipse(cx, my + 3, 10, 4, 0, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = css(0xb8727a);
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(cx - 10, my + 1);
    c.quadraticCurveTo(cx, my + 4, cx + 10, my + 1);
    c.stroke();
  }
  if (look.mole) {
    c.fillStyle = css(0x5a3a32);
    c.beginPath();
    c.arc(cx - 78, 306, 2.8, 0, Math.PI * 2);
    c.fill();
  }
  return cv;
}

/** 애니 눈 하나. dir = 바깥 눈꼬리 방향 (+1 = 캔버스 오른쪽) */
function eye(c: CanvasRenderingContext2D, ex: number, ey: number, dir: 1 | -1, look: Look): void {
  const w = 68;
  const h = 60;
  const inner = { x: ex - dir * w * 0.5, y: ey + 6 };
  const outer = { x: ex + dir * w * 0.5, y: ey - 4 };
  const lower = look.smile ? 0.34 : 0.46;
  const shape = () => {
    c.beginPath();
    c.moveTo(inner.x, inner.y);
    c.bezierCurveTo(ex - dir * w * 0.28, ey - h * 0.62, ex + dir * w * 0.3, ey - h * 0.62, outer.x, outer.y);
    c.bezierCurveTo(ex + dir * w * 0.25, ey + h * lower, ex - dir * w * 0.22, ey + h * lower, inner.x, inner.y);
  };
  c.save();
  shape();
  c.clip();
  c.fillStyle = css(0xfbf7f4);
  c.fillRect(ex - w, ey - h, w * 2, h * 2);
  const g = c.createLinearGradient(0, ey - 28, 0, ey + 30);
  g.addColorStop(0, css(shade(look.eyes, -0.6)));
  g.addColorStop(0.45, css(look.eyes));
  g.addColorStop(1, css(shade(look.eyes, 0.42)));
  c.fillStyle = g;
  c.beginPath();
  c.ellipse(ex + dir * 1, ey + 3, 21, 28, 0, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = css(shade(look.eyes, -0.65));
  c.lineWidth = 2.5;
  c.stroke();
  c.fillStyle = css(shade(look.eyes, -0.78));
  c.beginPath();
  c.ellipse(ex + dir * 1, ey + 5, 8.5, 12.5, 0, 0, Math.PI * 2);
  c.fill();
  // 위 눈꺼풀 그늘
  c.fillStyle = rgba(0x462828, 0.28);
  c.fillRect(ex - w, ey - h, w * 2, h * 0.44);
  c.fillStyle = css(0xffffff);
  c.beginPath();
  c.arc(ex - dir * 7, ey - 7, 7, 0, Math.PI * 2);
  c.arc(ex + dir * 9, ey + 14, 3.2, 0, Math.PI * 2);
  c.fill();
  c.restore();
  // 위 속눈썹 (바깥 눈꼬리가 굵게 올라간다)
  c.strokeStyle = css(0x2a1e1e);
  c.lineCap = 'round';
  c.lineWidth = 6;
  c.beginPath();
  c.moveTo(inner.x + dir * 3, inner.y - 2);
  c.bezierCurveTo(ex - dir * w * 0.28, ey - h * 0.62, ex + dir * w * 0.3, ey - h * 0.62, outer.x, outer.y);
  c.stroke();
  c.fillStyle = css(0x2a1e1e);
  c.beginPath();
  c.moveTo(outer.x - dir * 8, outer.y - 6);
  c.lineTo(outer.x + dir * 11, outer.y - 11);
  c.lineTo(outer.x - dir * 1, outer.y + 4);
  c.fill();
  // 아래 속눈썹 (바깥쪽 절반만 옅게)
  c.strokeStyle = rgba(0x5a3737, 0.55);
  c.lineWidth = 1.6;
  c.beginPath();
  c.moveTo(outer.x - dir * 2, outer.y + 3);
  c.quadraticCurveTo(ex + dir * w * 0.2, ey + h * lower * 0.9, ex, ey + h * lower * 0.85);
  c.stroke();
}
