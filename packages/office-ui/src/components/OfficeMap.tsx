// 사무실 지도 (12장). 시스템 상태를 사무실 풍경으로 바꿔 보여준다.
// 바닥·가구는 Floor.tsx(회색 세트와 그 섞음), 조합색은 상태 표시에만 쓴다 (17장).
import { motion } from 'motion/react';
import { useSyncExternalStore } from 'react';
import type { Snapshot } from '@ai-office/shared';
import type { Director } from '../director.ts';
import { APPROVAL_TRAY, BUDGET_GAUGE, CEO_DESK, GRID, MAILBOX, MODEL_NOTE, RACKS, ROOMS, type Point } from '../map.ts';
import { Character } from './Character.tsx';
import { Floor, G } from './Floor.tsx';
import { fullName } from '../format.ts';

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
  // 방 이름 옆 인원: 그 부서의 상시 직원 수 (임시 직원·나간 직원 제외)
  const headcount = (departments: readonly string[]) => snapshot.employees.filter((e) => !e.isTemporary && !e.leftAt && departments.includes(e.department)).length;

  return (
    <div className="ao-map" role="region" aria-label={`사무실 지도. 결재 대기 ${pending}건, ${snapshot.system.ceoPresent ? 'CEO 접속 중' : 'CEO 부재'}`}>
      <svg viewBox={`0 0 ${GRID.w * G} ${GRID.h * G}`} className="ao-map__floor" aria-hidden="true">
        <Floor />
        {/* 일하는 책상만 스탠드 (밤) */}
        {night &&
          chars
            .filter((c) => working.has(c.id) && c.visible)
            .map((c) => <circle key={c.id} cx={c.pos.x * G} cy={(c.pos.y - 0.4) * G} r={1.4 * G} style={{ fill: 'var(--point)', opacity: 0.18 }} />)}
        {/* CEO실: 접속 중이면 불이 켜짐 */}
        {snapshot.system.ceoPresent && <circle cx={CEO_DESK.x * G} cy={CEO_DESK.y * G} r={1.6 * G} style={{ fill: 'var(--point)', opacity: 0.16 }} />}
        {/* 결재 대기 서류 */}
        {Array.from({ length: Math.min(pending, 5) }, (_, i) => (
          <rect key={i} x={(APPROVAL_TRAY.x - 0.4) * G + i * 4} y={APPROVAL_TRAY.y * G - i * 4} width={0.8 * G} height={0.55 * G} rx="2" style={{ fill: 'var(--surface)', stroke: 'var(--control)' }} />
        ))}
        {/* 서버실 랙 불빛: 모델 교체 때 깜빡임 */}
        {RACKS.flatMap((r, i) =>
          [0, 1, 2, 3].map((k) => <circle key={`${i}-${k}`} cx={r.x * G} cy={(r.y - 0.8 + k * 0.8) * G} r="4" className={blinking ? 'ao-blink' : undefined} style={{ fill: 'var(--primary-icon)' }} />),
        )}
        {/* 예산 게이지: 상한에 가까우면 빨갛게 차오름 */}
        <rect x={BUDGET_GAUGE.x * G} y={BUDGET_GAUGE.y * G} width={0.26 * G} height={BUDGET_GAUGE.h * G} rx="5" style={{ fill: 'var(--row)' }} />
        <rect
          x={BUDGET_GAUGE.x * G}
          y={(BUDGET_GAUGE.y + BUDGET_GAUGE.h * (1 - Math.min(maxUse, 1))) * G}
          width={0.26 * G}
          height={BUDGET_GAUGE.h * Math.min(maxUse, 1) * G}
          rx="5"
          style={{ fill: maxUse >= 0.9 ? 'var(--danger)' : 'var(--primary-mark)' }}
        />
        {/* 밤: 사무실 조명이 어두워짐 */}
        {night && <rect x="0" y="0" width={GRID.w * G} height={GRID.h * G} rx="20" className="ao-night" />}
      </svg>

      {ROOMS.map((r) => {
        const n = headcount(r.departments);
        return (
          <span key={r.id} className="ao-room-label" style={pct({ x: r.x + 0.3, y: r.y + 0.3 })}>
            {r.name}
            {n > 0 && <span className="ao-room-label__count"> {n}명</span>}
          </span>
        );
      })}
      {pending > 0 && (
        <span className="pt-badge pt-badge--primary ao-tray-badge" style={pct({ x: APPROVAL_TRAY.x - 1.4, y: APPROVAL_TRAY.y + 0.6 })}>
          <span className="pt-badge__dot" />
          결재 {pending}
        </span>
      )}
      {snapshot.system.loadedModel && (
        <span className="ao-room-note" style={pct(MODEL_NOTE)}>
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
              className={`ao-char ao-char--${e.rank}`}
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
              <button type="button" className="ao-char__body" aria-label={`${fullName(e)}${t ? `, ${t.id}` : ''} 상세`} onClick={() => onSelectEmployee(e.id)}>
                <Character spriteSet={e.spriteSet} pose={c.pose} facing={c.facing} />
                {c.carrying && <span className="ao-box-label">{c.carrying}</span>}
              </button>
              {/* 이름표: 팀장은 별, 보조 직원은 이름만 작게 (두뇌는 늘 Gemma라 상세·직원 탭에) */}
              <span className={`ao-nametag ao-nametag--${e.rank}`}>
                <span className="ao-nametag__name">
                  <span className={`ao-dot ao-dot--${c.status}`} />
                  {e.rank === 'lead' && (
                    <span className="material-symbols-rounded ao-nametag__lead" aria-label="팀장">
                      star
                    </span>
                  )}
                  {/* 지도 이름표는 짧게: 캐릭터 이름이 있으면 이름만 (직함은 상세·직원 탭에) */}
                  {e.personalName ?? e.displayName}
                  {e.isTemporary ? ' · 방문' : ''}
                </span>
                {e.rank !== 'assistant' && <span className="ao-nametag__brain">{e.brainLabel}</span>}
              </span>
            </motion.div>
          );
        })}
    </div>
  );
}
