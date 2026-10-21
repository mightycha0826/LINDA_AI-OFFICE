// 직원 탭: 개편 조직도(2-0)를 부서별로. 팀장 → 팀원 → 보조 직원 순, 지금 하는 일과 두뇌를 함께 보여 준다.
// 지도가 작은 폰에서도 누가 무엇을 하는지 한눈에 보이게 한다. 누르면 직원 상세가 열린다.
import { currentTicketOf, deriveEmployeeStatus, type Snapshot } from '@ai-office/shared';
import { fullName, RANK_LABEL, STATUS_LABEL, WORK_LABEL } from '../format.ts';
import { staffGroups } from '../staff.ts';

interface Props {
  snapshot: Snapshot;
  onSelectEmployee: (id: string) => void;
}

export function StaffTab({ snapshot, onSelectEmployee }: Props) {
  return (
    <div className="ao-work">
      {staffGroups(snapshot.employees).map((g) => (
        <section key={g.title} className="ao-group">
          <h3 className="ao-group__title">
            {g.title} <span className="ao-num">{g.members.length}</span>
          </h3>
          <div className="ao-group__list">
            {g.members.map((e) => {
              const status = deriveEmployeeStatus(e.id, snapshot.tickets, e.leftAt);
              const t = currentTicketOf(e.id, snapshot.tickets);
              return (
                <button key={e.id} type="button" className="ao-ticket ao-staff" onClick={() => onSelectEmployee(e.id)}>
                  <span className="ao-ticket__line">
                    <span className={`ao-dot ao-dot--${status}`} aria-hidden="true" />
                    {e.rank === 'lead' && (
                      <span className="material-symbols-rounded ao-nametag__lead" aria-hidden="true">
                        star
                      </span>
                    )}
                    <span className="ao-ticket__title">{fullName(e)}</span>
                    <span className="ao-ticket__type">
                      {RANK_LABEL[e.rank]} · {e.brainLabel}
                    </span>
                  </span>
                  {e.job && <span className="ao-ticket__meta">{e.job}</span>}
                  <span className="ao-ticket__meta">{t ? `${t.id} ${STATUS_LABEL[t.status]}` : WORK_LABEL[status]}</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
