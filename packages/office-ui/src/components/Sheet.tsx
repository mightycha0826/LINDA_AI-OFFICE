// 상세 시트: PC는 오른쪽 패널 위에 덮고, 폰은 아래에서 올라온다 (12장 "직원을 누르면 아래에서 상세").
// 포인트 시스템에 없는 팝업이라 point.extra.css에 임시 스타일로 둔다 (17장).
import { useEffect, useRef, type ReactNode } from 'react';

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="ao-sheet-backdrop" onClick={onClose}>
      <div className="ao-sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="ao-sheet__head">
          <h2>{title}</h2>
          <button type="button" className="pt-icon-btn" aria-label="닫기" onClick={onClose}>
            <span className="material-symbols-rounded" aria-hidden="true">
              close
            </span>
          </button>
        </div>
        <div className="ao-sheet__body">{children}</div>
      </div>
    </div>
  );
}
