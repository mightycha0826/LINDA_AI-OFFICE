// 첫 스냅샷을 받기 전 화면: 사무실을 여는 중, 또는 불러오지 못함(다시 시도).
export function BootScreen({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  return (
    <main className="ao-boot">
      <div className={`pt-empty${failed ? ' pt-empty--error' : ' pt-empty--loading'}`} role="status">
        <div className="pt-empty__disc">
          <span className="material-symbols-rounded" aria-hidden="true">
            {failed ? 'cloud_off' : 'progress_activity'}
          </span>
        </div>
        <p className="pt-empty__title">{failed ? '불러오지 못했어요' : '사무실을 여는 중'}</p>
        <p className="pt-empty__text">{failed ? '오케스트레이터가 켜져 있는지 확인해 주세요' : '잠시만 기다려 주세요'}</p>
        {failed && (
          <button type="button" className="pt-btn" onClick={onRetry}>
            <span className="material-symbols-rounded" aria-hidden="true">
              refresh
            </span>
            다시 시도
          </button>
        )}
      </div>
    </main>
  );
}
