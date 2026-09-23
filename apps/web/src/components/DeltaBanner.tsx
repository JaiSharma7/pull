export function DeltaBanner({
  count,
  estimatedMinutes,
}: {
  count: number | null;
  estimatedMinutes: number | null;
}) {
  if (count === null || count <= 0 || estimatedMinutes === null) return null;

  return (
    <p className="meta" data-testid="delta-banner">
      Latest search set aside {count} {count === 1 ? 'matched idea' : 'matched ideas'} from its
      candidate pool —{' '}
      <span style={{ color: 'var(--accent)' }}>
        about {estimatedMinutes} min of estimated reading
      </span>
    </p>
  );
}
