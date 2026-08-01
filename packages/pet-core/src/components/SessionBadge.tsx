/**
 * How many agent sessions are live.
 *
 * Only shown past one: the count answers "is the pet talking about the thing I
 * am looking at?", which is not a question a single session raises.
 */
export function SessionBadge({ count }: { readonly count: number }) {
  if (count <= 1) return null;
  return (
    <div className="pet-badge" title={`${count} live sessions`}>
      {count}
    </div>
  );
}
