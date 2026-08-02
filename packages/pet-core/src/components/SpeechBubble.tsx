/**
 * What every live session is doing, one line each.
 *
 * It began as a single word for the one session the focus policy picked, which
 * meant that with three agents running you could see one of them and had no way
 * to know the other two existed. Worse, an unanswered prompt in a project you
 * had walked away from held the whole bubble — the pet was faithfully showing a
 * question you were no longer asking.
 *
 * A line each dissolves that. The sprite still animates one session, because
 * the pet has one body; the bubble does not have that constraint.
 *
 * It renders strings and does not derive them. It used to call `speechFor`
 * itself while `App` called it again for the log line, and the two disagreed
 * for three rounds without anything failing.
 */

export interface SpeechLine {
  readonly id: string;
  /** Shown only when there is more than one line to tell apart. */
  readonly project?: string | undefined;
  readonly text: string;
  /** Waiting on the user. Sorted to the top and marked. */
  readonly attention?: boolean;
}

export function SpeechBubble({ lines }: { readonly lines: readonly SpeechLine[] }) {
  if (lines.length === 0) return null;
  const many = lines.length > 1;

  return (
    <div className="pet-bubble" role="status" data-rows={lines.length}>
      {lines.map((line) => (
        <div className="pet-bubble-line" key={line.id} data-attention={line.attention || undefined}>
          {many && line.project ? <span className="pet-bubble-project">{line.project}</span> : null}
          <span className="pet-bubble-text">{line.text}</span>
        </div>
      ))}
    </div>
  );
}
