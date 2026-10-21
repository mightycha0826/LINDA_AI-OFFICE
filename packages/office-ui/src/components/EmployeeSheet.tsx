// 직원 상세 (12장: 직원을 누르면 PC는 오른쪽, 폰은 아래에서 올라온다).
// 맨 위에 증명사진(13장, assets/portraits/<직원 ID>)과 개인 이름·직함, 그 아래 하는 일, 두뇌, 지금 티켓.
import type { ScreenEmployee, ScreenTicket } from '@ai-office/shared';
import { fullName, RANK_LABEL, STATUS_LABEL } from '../format.ts';
import { Sheet } from './Sheet.tsx';

interface Props {
  employee: ScreenEmployee;
  ticket: ScreenTicket | null;
  onClose: () => void;
  onOpenTicket: (id: string) => void;
}

export function EmployeeSheet({ employee: e, ticket, onClose, onOpenTicket }: Props) {
  const name = e.personalName ?? e.displayName;
  return (
    <Sheet title={fullName(e)} onClose={onClose}>
      <div className="ao-profile">
        <figure className="ao-portrait">
          {e.portrait ? (
            <img src={e.portrait} alt={`${name} 증명사진`} />
          ) : (
            <span className="material-symbols-rounded" role="img" aria-label="증명사진 없음">
              person
            </span>
          )}
        </figure>
        <div className="ao-profile__text">
          <p className="ao-profile__name">{name}</p>
          {e.personalName && <p className="ao-profile__title">{e.displayName}</p>}
          <p className="ao-profile__title">
            {e.department} · {RANK_LABEL[e.rank]}
          </p>
        </div>
      </div>
      <dl className="ao-dl">
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
