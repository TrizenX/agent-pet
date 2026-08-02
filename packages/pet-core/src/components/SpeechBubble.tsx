import { useEffect, useState } from "react";

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
  /** Long silent. Still listed, but it should not compete with live work. */
  readonly quiet?: boolean;
}

/**
 * Report the bubble's actual geometry, once per change.
 *
 * Every layout bug this component has had was invisible to the test suite and
 * obvious on screen: a bubble clipped at the window edge, one floating a
 * hundred pixels above a small pet, one sized to half the window it was
 * centred in. jsdom does no layout, so none of them could be asserted there —
 * `textContent` is identical whether or not a line is truncated.
 *
 * WebKit does do layout. This is the one place that can answer "is any of it
 * actually visible", so it says so out loud and `tools/layout/check.py` reads
 * it back. Same channel and same cost as the `[pet] … says` line beside it:
 * one line when something changes, nothing while the pet is asleep (I6).
 */
function useReportGeometry(node: HTMLDivElement | null, key: string): void {
  // `key` changes whenever the rendered text does, which is exactly when the
  // geometry can change. The linter cannot see that it is read inside the
  // effect's own body, because it is not.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measuring after the text changes is the point
  useEffect(() => {
    if (!node) return;
    const view = document.documentElement;
    const box = node.getBoundingClientRect();
    const styles = getComputedStyle(view);
    const petH = Number.parseFloat(styles.getPropertyValue("--pet-h")) || 0;

    // A line is truncated when its text needs more room than it was given.
    const truncated = [...node.querySelectorAll<HTMLElement>(".pet-bubble-text")].filter(
      (el) => el.scrollWidth > el.clientWidth + 1,
    ).length;
    const outside =
      box.left < 0 || box.top < 0 || box.right > view.clientWidth || box.bottom > view.clientHeight;
    // The gap between the bubble's underside and the top of the sprite.
    const gap = Math.round(view.clientHeight - petH - box.bottom);

    console.log(
      `[layout] bubble ${Math.round(box.width)}x${Math.round(box.height)} ` +
        `at ${Math.round(box.left)},${Math.round(box.top)} ` +
        `window ${view.clientWidth}x${view.clientHeight} gap ${gap} ` +
        `truncated ${truncated} outside ${outside}`,
    );
  }, [node, key]);
}

export function SpeechBubble({ lines }: { readonly lines: readonly SpeechLine[] }) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  useReportGeometry(node, lines.map((l) => `${l.project}:${l.text}`).join("|"));

  if (lines.length === 0) return null;
  const many = lines.length > 1;

  return (
    <div className="pet-bubble" role="status" data-rows={lines.length} ref={setNode}>
      {lines.map((line) => (
        <div
          className="pet-bubble-line"
          key={line.id}
          data-attention={line.attention || undefined}
          data-quiet={line.quiet || undefined}
        >
          {many && line.project ? <span className="pet-bubble-project">{line.project}</span> : null}
          <span className="pet-bubble-text">{line.text}</span>
        </div>
      ))}
    </div>
  );
}
