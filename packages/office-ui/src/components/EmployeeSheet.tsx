// 직원 상세 (12장: 직원을 누르면 PC는 오른쪽, 폰은 아래에서 올라온다). 부서 · 직급, 하는 일, 두뇌, 지금 티켓.
import type { ScreenEmployee, ScreenTicket } from '@ai-office/shared';
import { RANK_LABEL, STATUS_LABEL } from '../format.ts';
import { Sheet } from './Sheet.tsx';

interface Props {
  employee: ScreenEmployee;
  ticket: ScreenTicket | null;
  onClose: () => void;
  onOpenTicket: (id: string) => void;
}

export function EmployeeSheet({ employee: e, ticket, onClose, onOpenTicket }: Props) {
  return (
    <Sheet title={e.displayName} onClose={onClose}>
      <dl className="ao-dl">
        <dt>부서</dt>
        <dd>
          {e.department} · {RANK_LABEL[e.rank]}
        </dd>
        {e.job && (
          <>
            <dt>하는 일</dt>
            <dd>{e.job}</dd>
          </>
        )}
        <dt>두뇌</dt>
        <dd>{e.brainLabel}</dd>
        <dt>지금</dt>
        <dd>{ticket ? `${ticket.id} ${STATUS_LABEL[ticket.status]}` : '대기 중'}</dd>
      </dl>
      {ticket && (
        <button type="button" className="pt-btn pt-btn--primary" onClick={() => onOpenTicket(ticket.id)}>
          {ticket.id} 상세 보기
        </button>
      )}
    </Sheet>
  );
}
