import type { LogEntry } from "../hooks/useAgentEvents.ts";

/**
 * The last 200 events, and what each became.
 *
 * Non-negotiable for a system whose inputs are invisible: without it, the only
 * report anyone can give is "the pet looked wrong". Costs an afternoon, saves a
 * week.
 *
 * In memory only. Payloads carry file paths and prompt text, and §10 says
 * Phase 1 writes none of that to disk.
 */
export function EventLog({
  entries,
  open,
  onClose,
}: {
  readonly entries: readonly LogEntry[];
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div className="pet-log">
      <div className="pet-log-head">
        <span>events ({entries.length})</span>
        <button type="button" onClick={onClose} aria-label="Close event log">
          ×
        </button>
      </div>
      <ol className="pet-log-list">
        {entries
          .slice()
          .reverse()
          .map((e) => (
            <li
              key={`${e.at}-${e.summary}`}
              data-dropped={e.summary.startsWith("dropped") || undefined}
            >
              <span className="pet-log-time">
                {new Date(e.at).toLocaleTimeString(undefined, { hour12: false })}
              </span>
              <span className="pet-log-source">{e.source}</span>
              <span>{e.summary}</span>
            </li>
          ))}
      </ol>
    </div>
  );
}
