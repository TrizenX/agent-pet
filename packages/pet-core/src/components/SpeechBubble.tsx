/**
 * A word, not a message. The bubble is a glance target; anything long enough to
 * read is long enough to ignore.
 *
 * It renders a string and does not derive one. It used to call `speechFor`
 * itself while `App` called it again for the log line, and the two disagreed
 * for three rounds without anything failing: the log printed the full command
 * and the pet on screen said "Chạy…", because `App` had stopped passing one of
 * the arguments. One derivation means the log is, by construction, what the
 * user is looking at.
 *
 * The project name is prefixed only when more than one session is live (§8.3) —
 * with one session the user knows what they are running.
 */
export function SpeechBubble({
  text,
  project,
}: {
  readonly text: string | undefined;
  readonly project?: string | undefined;
}) {
  if (!text) return null;
  return (
    <div className="pet-bubble" role="status">
      {project ? <span className="pet-bubble-project">{project}</span> : null}
      {text}
    </div>
  );
}
