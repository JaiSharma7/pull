export interface MeterProps {
  /** 0..1 */
  value: number;
  label: string;
}

/** A hairline progress rule. Deliberately not a candy-rounded pill. */
export function Meter({ value, label }: MeterProps) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className="meter"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className="meter__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
