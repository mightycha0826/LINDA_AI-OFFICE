// 사무실 지도 (12장). 시스템 상태를 사무실 풍경으로 바꿔 보여준다.
// 벽·바닥·가구는 회색 세트(row, track, control)로만 칠하고, 조합색은 상태 표시에만 쓴다 (17장).
import { motion } from 'motion/react';
import { useSyncExternalStore } from 'react';
import type { Snapshot } from '@ai-office/shared';
import type { Director } from '../director.ts';
import { APPROVAL_TRAY, CEO_DESK, DESKS, GRID, MAILBOX, MEETING_CHAIRS, RACKS, ROOMS, TEMP_SLOTS, type Point } from '../map.ts';
import { Character } from './Character.tsx';

const G = 40; // 그림 좌표: 한 칸 40, 전체 960 × 640
const pct = (p: Point) => ({ left: `${(p.x / GRID.w) * 100}%`, top: `${(p.y / GRID.h) * 100}%` });

interface Props {
  snapshot: Snapshot;
  director: Director;
  night: boolean;
  onOpenTicket: (id: string) => void;
  onSelectEmployee: (id: string) => void;
}

export function OfficeMap({ snapshot, director, night, onOpenTicket, onSelectEmployee }: Props) {
  useSyncExternalStore(director.subscribe, director.getVersion);
  const chars = director.list();
  const byId = new Map(snapshot.employees.map((e) => [e.id, e]));
  const pending = snapshot.approvals.length;
  const maxUse = Math.max(...snapshot.usage.map((u) => (u.fiveHourLimit ? u.fiveHour / u.fiveHourLimit : 0)), 0);
  const blinking = director.props.rackBlinkUntil > Date.now();
  const working = new Set(chars.filter((c) => c.status === 'working' || c.status === 'reviewing').map((c) => c.id));

  return (
    <div className="ao-map" role="img" aria-label={`사무실 지도. 결재 대기 ${pending}건, ${snapshot.system.ceoPresent ? 'CEO 접속 중' : 'CEO 부재'}`}>
      <svg viewBox={`0 0 ${GRID.w * G} ${GRID.h * G}`} className="ao-map__floor" aria-hidden="true">
        <rect x="0" y="0" width={GRID.w * G} height={GRID.h * G} rx="16" style={{ fill: 'var(--track)' }} />
        {ROOMS.map((r) => (
          <g key={r.id}>
            <rect x={r.x * G} y={r.y * G} width={r.w * G} height={r.h * G} rx="12" style={{ fill: 'var(--row)', stroke: 'var(--control)', strokeWidth: 2 }} />
            <rect x={(r.door.x - 0.5) * G} y={(r.door.y - 0.15) * G} width={G} height={0.3 * G} style={{ fill: 'var(--track)' }} />
          </g>
        ))}
        {/* 책상 */}
        {[...Object.values(DESKS), ...TEMP_SLOTS].map((d, i) => (
          <rect key={i} x={(d.x - 1) * G} y={(d.y - 0.1) * G} width={2 * G} height={0.8 * G} rx="6" style={{ fill: 'var(--surface)', stroke: 'var(--track)' }} />
        ))}
        {/* 일하는 책상만 스탠드 (밤) */}
        {night &&
          chars
            .filter((c) => working.has(c.id) && c.visible)
            .map((c) => <circle key={c.id} cx={c.pos.x * G} cy={(c.pos.y - 0.4) * G} r={1.4 * G} style={{ fill: 'var(--point)', opacity: 0.18 }} />)}
        {/* CEO실: 접속 중이면 불이 켜짐 */}
        <rect x={(CEO_DESK.x - 1.4) * G} y={(CEO_DESK.y - 0.2) * G} width={2.8 * G} height={1 * G} rx="8" style={{ fill: 'var(--surface)', stroke: 'var(--track)' }} />
        {snapshot.system.ceoPresent && <circle cx={CEO_DESK.x * G} cy={CEO_DESK.y * G} r={1.6 * G} style={{ fill: 'var(--point)', opacity: 0.16 }} />}
        {/* 결재 대기 서류 */}
        {Array.from({ length: Math.min(pending, 5) }, (_, i) => (
          <rect key={i} x={(APPROVAL_TRAY.x - 0.4) * G + i * 4} y={APPROVAL_TRAY.y * G - i * 4} width={0.8 * G} height={0.55 * G} rx="2" style={{ fill: 'var(--surface)', stroke: 'var(--control)' }} />
        ))}
        {/* 회의실 탁자 */}
        <rect x={(MEETING_CHAIRS[0]!.x - 0.2) * G} y={(MEETING_CHAIRS[0]!.y - 1.6) * G} width={(MEETING_CHAIRS[1]!.x - MEETING_CHAIRS[0]!.x + 0.4) * G} height={1.2 * G} rx="12" style={{ fill: 'var(--surface)', stroke: 'var(--track)' }} />
        {/* 서버실 랙: 모델 교체 때 깜빡임 */}
        {RACKS.map((r, i) => (
          <g key={i}>
            <rect x={(r.x - 0.5) * G} y={(r.y - 1.2) * G} width={G} height={3.6 * G} rx="4" style={{ fill: 'var(--control)' }} />
            {[0, 1, 2, 3].map((k) => (
              <circle key={k} cx={r.x * G} cy={(r.y - 0.8 + k * 0.8) * G} r="4" className={blinking ? 'ao-blink' : undefined} style={{ fill: 'var(--primary-icon)' }} />
            ))}
          </g>
        ))}
        {/* 우체통 */}
        <rect x={(MAILBOX.x - 0.45) * G} y={(MAILBOX.y - 1) * G} width={0.9 * G} height={1.1 * G} rx="6" style={{ fill: 'var(--control)' }} />
        {/* 예산 게이지: 상한에 가까우면 빨갛게 차오름 */}
        <rect x={23.55 * G} y={1 * G} width={0.3 * G} height={6 * G} rx="6" style={{ fill: 'var(--row)' }} />
        <rect x={23.55 * G} y={(1 + 6 * (1 - Math.min(maxUse, 1))) * G} width={0.3 * G} height={6 * Math.min(maxUse, 1) * G} rx="6" style={{ fill: maxUse >= 0.9 ? 'var(--danger)' : 'var(--primary-mark)' }} />
        {/* 밤: 사무실 조명이 어두워짐 */}
        {night && <rect x="0" y="0" width={GRID.w * G} height={GRID.h * G} rx="16" className="ao-night" />}
      </svg>

      {ROOMS.map((r) => (
        <span key={r.id} className="ao-room-label" style={pct({ x: r.x + 0.3, y: r.y + 0.3 })}>
          {r.name}
        </span>
      ))}
      {pending > 0 && (
        <span className="pt-badge pt-badge--primary ao-tray-badge" style={pct({ x: APPROVAL_TRAY.x - 1.4, y: APPROVAL_TRAY.y + 0.6 })}>
          <span className="pt-badge__dot" />
          결재 {pending}
        </span>
      )}
      {snapshot.system.loadedModel && (
        <span className="ao-room-note" style={pct({ x: 20.5, y: 14.6 })}>
          {snapshot.system.loadedModel}
        </span>
      )}
      {director.props.mailbox !== 'idle' && (
        <span className="material-symbols-rounded ao-mailbox-mark" aria-label={director.props.mailbox === 'ok' ? '발송 완료' : '발송 실패'} style={{ ...pct({ x: MAILBOX.x, y: MAILBOX.y - 1.6 }), color: director.props.mailbox === 'ok' ? 'var(--primary-icon)' : 'var(--danger)' }}>
          {director.props.mailbox === 'ok' ? 'check_circle' : 'error'}
        </span>
      )}

      {chars
        .filter((c) => c.visible)
        .map((c) => {
          const e = byId.get(c.id);
          if (!e) return null;
          const t = director.ticketOf(c.id);
          return (
            <motion.div
              key={c.id}
              className="ao-char"
              initial={false}
              animate={pct(c.pos)}
              transition={{ duration: c.moveSec, ease: 'linear' }}
            >
              {c.bubble && (
                <button type="button" className="ao-bubble" onClick={() => c.bubble?.ticketId && onOpenTicket(c.bubble.ticketId)}>
                  {c.bubble.text}
                </button>
              )}
              {c.status === 'blocked' && (
                <span className="material-symbols-rounded ao-over ao-over--warn" aria-label="막힘">
                  warning
                </span>
              )}
              {c.status === 'paused' && <span className="ao-over ao-zzz">Zzz</span>}
              <button type="button" className="ao-char__body" aria-label={`${e.displayName}${t ? `, ${t.id}` : ''} 상세`} onClick={() => onSelectEmployee(e.id)}>
                <Character spriteSet={e.spriteSet} pose={c.pose} facing={c.facing} />
                {c.carrying && <span className="ao-box-label">{c.carrying}</span>}
              </button>
              <span className="ao-nametag">
                <span className={`ao-dot ao-dot--${c.status}`} />
                {e.displayName}
                {e.isTemporary ? ' · 방문' : ''}
                <span className="ao-nametag__brain">
                  {e.brainLabel}
                </span>
              </span>
            </motion.div>
          );
        })}
    </div>
  );
}
