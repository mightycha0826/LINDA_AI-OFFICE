// 사무실 바닥·가구 그림 (12장, 2026-10-21 CEO 요청: 네이버 1784 사옥 느낌).
// 밝은 나무 바닥, 유리 칸막이, 화분, 라운지를 회색 세트(surface, row, track, control, ink)와 그 섞음(color-mix)으로만 그린다.
// 조합색은 상태 표시(랙 불빛, CEO 접속, 예산 게이지)에만 쓴다 (17장). 좌표는 map.ts 그대로다.
import { CEO_DESK, DESKS, GRID, MAILBOX, MEETING_CHAIRS, RACKS, ROOMS, TEMP_SLOTS, CORRIDOR_Y, type Point, type Room } from '../map.ts';

export const G = 40; // 그림 좌표: 한 칸 40, 전체 1200 × 800

const mix = (a: string, pctA: number, b = 'transparent') => `color-mix(in srgb, var(${a}) ${pctA}%, ${b})`;
const C = {
  atrium: 'var(--row)',
  plank: 'var(--surface)',
  seam: mix('--track', 45),
  glass: mix('--control', 60),
  glassHi: 'var(--surface)',
  wood: mix('--control', 45, 'var(--surface)'),
  woodEdge: mix('--control', 80),
  chair: mix('--ink', 22, 'var(--surface)'),
  screen: mix('--ink', 78),
  leaf: mix('--ink-muted', 55, 'var(--surface)'),
  leafHi: mix('--ink-muted', 25, 'var(--surface)'),
  pot: 'var(--control)',
  sofa: mix('--ink', 14, 'var(--row)'),
  rug: mix('--track', 55),
  window: mix('--surface', 80),
};

/** 화분: 둥근 화분에서 길쭉한 잎이 퍼진다 (위에서 본 모습) */
function Plant({ p, r = 0.55 }: { p: Point; r?: number }) {
  const cx = p.x * G;
  const cy = p.y * G;
  const R = r * G;
  return (
    <g filter="url(#ao-soft)">
      <circle cx={cx} cy={cy} r={R * 0.42} style={{ fill: C.pot }} />
      {[15, 75, 135, 195, 255, 315].map((deg, i) => (
        <ellipse
          key={deg}
          cx={cx + Math.cos((deg * Math.PI) / 180) * R * 0.5}
          cy={cy + Math.sin((deg * Math.PI) / 180) * R * 0.5}
          rx={R * 0.52}
          ry={R * 0.24}
          transform={`rotate(${deg} ${cx + Math.cos((deg * Math.PI) / 180) * R * 0.5} ${cy + Math.sin((deg * Math.PI) / 180) * R * 0.5})`}
          style={{ fill: i % 2 ? C.leaf : C.leafHi, stroke: C.leaf, strokeWidth: 0.75 }}
        />
      ))}
      <circle cx={cx} cy={cy} r={R * 0.16} style={{ fill: C.leaf }} />
    </g>
  );
}

/** 책상: 사람은 책상 위쪽(북쪽)에 서서 앞을 본다. 모니터는 아래 가장자리, 의자는 사람 발밑 */
function Desk({ d, temp = false }: { d: Point; temp?: boolean }) {
  const x = (d.x - 1) * G;
  const y = (d.y - 0.1) * G;
  return (
    <g opacity={temp ? 0.7 : 1}>
      <circle cx={d.x * G} cy={(d.y - 0.25) * G} r={0.42 * G} style={{ fill: C.chair }} />
      <rect x={x} y={y} width={2 * G} height={0.8 * G} rx="6" filter="url(#ao-soft)" style={{ fill: C.wood, stroke: C.woodEdge, strokeWidth: 1 }} />
      <rect x={x + 0.55 * G} y={y + 0.56 * G} width={0.9 * G} height={0.1 * G} rx="2" style={{ fill: C.screen }} />
      <rect x={x + 0.7 * G} y={y + 0.3 * G} width={0.6 * G} height={0.12 * G} rx="2" style={{ fill: C.plank }} />
    </g>
  );
}

/** 유리 칸막이: 방 테두리 + 안쪽 밝은 선 + 2칸마다 창살. 문 자리는 비운다 */
function GlassRoom({ r }: { r: Room }) {
  const x = r.x * G;
  const y = r.y * G;
  const w = r.w * G;
  const h = r.h * G;
  const doorTop = r.door.y === r.y;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx="14" filter="url(#ao-soft)" style={{ fill: 'url(#ao-plank)' }} />
      <rect x={x} y={y} width={w} height={h} rx="14" style={{ fill: 'none', stroke: C.glass, strokeWidth: 3 }} />
      <rect x={x + 3} y={y + 3} width={w - 6} height={h - 6} rx="11" style={{ fill: 'none', stroke: C.glassHi, strokeWidth: 1.5 }} />
      {/* 문: 칸막이를 끊고 문턱만 */}
      <rect x={(r.door.x - 0.6) * G} y={r.door.y * G - 4} width={1.2 * G} height={8} style={{ fill: C.atrium }} />
    </g>
  );
}

/** 방 구석 화분 자리 (칸 단위) */
const ROOM_PLANTS: Point[] = [
  { x: 11.3, y: 1.3 },
  { x: 11.3, y: 8.2 },
  { x: 6.8, y: 19 },
  { x: 11.9, y: 19 },
  { x: 18.4, y: 11.3 },
  { x: 25.4, y: 19 },
];

const ROOM = Object.fromEntries(ROOMS.map((r) => [r.id, r])) as Record<Room['id'], Room>;

export function Floor() {
  const W = GRID.w * G;
  const H = GRID.h * G;
  const meeting = ROOM.meeting;
  const ceo = ROOM.ceo;
  const server = ROOM.server;
  const [c0, c1] = [MEETING_CHAIRS[0]!, MEETING_CHAIRS[1]!];
  return (
    <>
      <defs>
        {/* 나무 바닥: 엇갈린 긴 판 두 줄 */}
        <pattern id="ao-plank" width={G * 4} height={G * 1.2} patternUnits="userSpaceOnUse">
          <rect width={G * 4} height={G * 1.2} style={{ fill: C.plank }} />
          <path
            d={`M 0 ${G * 0.6} H ${G * 4} M 0 ${G * 1.2} H ${G * 4} M ${G * 1.4} 0 V ${G * 0.6} M ${G * 3.2} ${G * 0.6} V ${G * 1.2}`}
            style={{ fill: 'none', stroke: C.seam, strokeWidth: 0.75 }}
          />
        </pattern>
        {/* 아트리움: 큰 돌판 */}
        <pattern id="ao-stone" width={G * 2} height={G * 2} patternUnits="userSpaceOnUse">
          <rect width={G * 2} height={G * 2} style={{ fill: C.atrium }} />
          <path d={`M ${G * 2} 0 L 0 0 0 ${G * 2}`} style={{ fill: 'none', stroke: C.seam, strokeWidth: 1 }} />
        </pattern>
        <filter id="ao-soft" x="-20%" y="-20%" width="140%" height="160%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" style={{ floodColor: 'var(--ink)', floodOpacity: 0.12 }} />
        </filter>
      </defs>

      {/* 건물: 돌판 바닥과 위쪽 긴 창 */}
      <rect x="0" y="0" width={W} height={H} rx="20" style={{ fill: 'url(#ao-stone)' }} />
      <rect x={G * 0.5} y={4} width={W - G} height={6} rx="3" style={{ fill: C.window }} />

      {ROOMS.map((r) => (
        <GlassRoom key={r.id} r={r} />
      ))}

      {/* 복도 라운지: 양 끝 화분과 가운데 벤치 */}
      {[2.5, 7.5, 12.6, 19.4, 22.2].map((x) => (
        <Plant key={x} p={{ x, y: CORRIDOR_Y }} r={0.42} />
      ))}
      <rect x={16.2 * G} y={(CORRIDOR_Y - 0.28) * G} width={2.4 * G} height={0.56 * G} rx="10" filter="url(#ao-soft)" style={{ fill: C.sofa }} />

      {/* 방 구석 화분: 이름 표지판·이름표와 겹치지 않는 자리 */}
      {ROOM_PLANTS.map((p) => (
        <Plant key={`${p.x},${p.y}`} p={p} r={0.5} />
      ))}

      {/* 책상 (방문 자리는 조금 옅게) */}
      {Object.values(DESKS).map((d, i) => (
        <Desk key={i} d={d} />
      ))}
      {TEMP_SLOTS.map((d, i) => (
        <Desk key={`t${i}`} d={d} temp />
      ))}

      {/* CEO실: 러그, 소파, 큰 책상 */}
      <rect x={(ceo.x + 0.6) * G} y={(ceo.y + 1) * G} width={(ceo.w - 1.2) * G} height={3.4 * G} rx="20" style={{ fill: C.rug, opacity: 0.6 }} />
      <rect x={(CEO_DESK.x - 1.4) * G} y={(CEO_DESK.y - 0.2) * G} width={2.8 * G} height={1 * G} rx="8" filter="url(#ao-soft)" style={{ fill: C.wood, stroke: C.woodEdge, strokeWidth: 1 }} />
      <rect x={(CEO_DESK.x - 0.6) * G} y={(CEO_DESK.y + 0.6) * G} width={1.2 * G} height={0.1 * G} rx="2" style={{ fill: C.screen }} />
      <rect x={(ceo.x + 0.7) * G} y={(ceo.y + 1.4) * G} width={0.7 * G} height={2.4 * G} rx="10" filter="url(#ao-soft)" style={{ fill: C.sofa }} />

      {/* 회의실: 긴 원목 탁자, 의자, 벽 화면 */}
      <rect x={(meeting.x + 1) * G} y={(meeting.y + 0.35) * G} width={(meeting.w - 2) * G} height={0.16 * G} rx="3" style={{ fill: C.screen }} />
      <rect x={(c0.x - 0.2) * G} y={(c0.y - 1.6) * G} width={(c1.x - c0.x + 0.4) * G} height={1.2 * G} rx="16" filter="url(#ao-soft)" style={{ fill: C.wood, stroke: C.woodEdge, strokeWidth: 1 }} />
      {[0.25, 0.5, 0.75].flatMap((t) => [
        { x: c0.x + (c1.x - c0.x) * t, y: c0.y - 1.95 },
        { x: c0.x + (c1.x - c0.x) * t, y: c0.y - 0.05 },
      ]).map((p, i) => (
        <circle key={i} cx={p.x * G} cy={p.y * G} r={0.3 * G} style={{ fill: C.chair }} />
      ))}

      {/* 서버실 바닥은 돌판, 랙은 짙은 회색 */}
      <rect x={server.x * G + 4} y={server.y * G + 4} width={server.w * G - 8} height={server.h * G - 8} rx="11" style={{ fill: 'url(#ao-stone)' }} />
      {RACKS.map((r, i) => (
        <rect key={i} x={(r.x - 0.5) * G} y={(r.y - 1.2) * G} width={G} height={3.6 * G} rx="4" filter="url(#ao-soft)" className="ao-rack" />
      ))}

      {/* 우체통 */}
      <rect x={(MAILBOX.x - 0.45) * G} y={(MAILBOX.y - 1) * G} width={0.9 * G} height={1.1 * G} rx="6" filter="url(#ao-soft)" style={{ fill: C.pot }} />
    </>
  );
}
