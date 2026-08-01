import type { PetState } from "../packs/stateMap.ts";
import { type Locale, speechFor } from "../packs/strings.ts";

/**
 * A word, not a message. The bubble is a glance target; anything long enough to
 * read is long enough to ignore.
 *
 * The project name is prefixed only when more than one session is live (§8.3) —
 * with one session the user knows what they are running.
 */
export function SpeechBubble({
  state,
  project,
  locale = "en",
  overrides,
}: {
  readonly state: PetState;
  readonly project?: string | undefined;
  readonly locale?: Locale;
  readonly overrides?: Partial<Record<PetState, string>>;
}) {
  const text = speechFor(state, locale, overrides);
  if (!text) return null;
  return (
    <div className="pet-bubble" role="status">
      {project ? <span className="pet-bubble-project">{project}</span> : null}
      {text}
    </div>
  );
}
