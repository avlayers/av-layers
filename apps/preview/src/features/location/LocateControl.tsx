export function LocateControl({ busy, disabled, onLocate }: { busy: boolean; disabled: boolean; onLocate: () => void }) {
  return (
    <button id="locate" type="button" aria-label="Go to current location" title="Go to current location" aria-busy={busy} disabled={disabled} onClick={onLocate}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" /><path d="M12 1v4m0 14v4M1 12h4m14 0h4" />
      </svg>
    </button>
  );
}
