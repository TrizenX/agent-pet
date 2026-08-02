import { useEffect, useMemo, useState } from "react";
import { type GalleryEntry, installFromGallery, loadGalleryIndex } from "../packs/gallery.ts";

/**
 * Getting a different pet, without a terminal.
 *
 * Today the answer is `npx petdex install <slug>`, which is a strange thing to
 * ask of someone who wanted a different cat. The gallery has four thousand of
 * them; this is a list and a button.
 *
 * The whole component is gated on `open` and mounts nothing until then, which
 * is how §12.4's "never fetch on launch" is enforced rather than intended: the
 * request lives in an effect that does not exist until the user opens this.
 */

/** Enough rows to scroll, few enough to render in one frame. */
const PAGE = 40;

type Status = { readonly slug: string; readonly text: string; readonly bad?: boolean };

export function PackPicker({
  open,
  installedIds,
  onClose,
  onInstalled,
}: {
  readonly open: boolean;
  readonly installedIds: readonly string[];
  readonly onClose: () => void;
  readonly onInstalled: (slug: string) => void;
}) {
  if (!open) return null;
  return <Picker installedIds={installedIds} onClose={onClose} onInstalled={onInstalled} />;
}

function Picker({
  installedIds,
  onClose,
  onInstalled,
}: {
  readonly installedIds: readonly string[];
  readonly onClose: () => void;
  readonly onInstalled: (slug: string) => void;
}) {
  const [entries, setEntries] = useState<readonly GalleryEntry[] | null>(null);
  const [note, setNote] = useState("loading the gallery…");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void loadGalleryIndex().then((index) => {
      if (!live) return;
      setEntries(index.entries);
      setNote(
        index.error ??
          `${index.entries.length} pets${index.cached ? " (cached)" : ""} — type to filter`,
      );
    });
    return () => {
      live = false;
    };
  }, []);

  const shown = useMemo(() => {
    if (!entries) return [];
    const q = query.trim().toLowerCase();
    const matched = q
      ? entries.filter((e) => e.slug.includes(q) || e.displayName.toLowerCase().includes(q))
      : entries;
    return matched.slice(0, PAGE);
  }, [entries, query]);

  async function install(entry: GalleryEntry) {
    setBusy(entry.slug);
    setStatus({ slug: entry.slug, text: "downloading…" });
    const result = await installFromGallery(entry);
    setBusy(null);
    if (result.ok) {
      setStatus({ slug: entry.slug, text: "installed" });
      onInstalled(result.id);
    } else {
      setStatus({ slug: entry.slug, text: result.reason, bad: true });
    }
  }

  return (
    <div className="pet-picker">
      <div className="pet-picker-head">
        <input
          type="search"
          value={query}
          placeholder="search pets"
          aria-label="Search the pet gallery"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" onClick={onClose} aria-label="Close the pet gallery">
          ×
        </button>
      </div>

      <div className="pet-picker-note">{note}</div>

      <ol className="pet-picker-list">
        {shown.map((entry) => {
          const installed = installedIds.includes(entry.slug);
          const mine = status?.slug === entry.slug;
          return (
            <li key={entry.slug}>
              <span className="pet-picker-name" title={entry.slug}>
                {entry.displayName}
              </span>
              {mine ? (
                <span className="pet-picker-status" data-bad={status.bad || undefined}>
                  {status.text}
                </span>
              ) : (
                <button type="button" disabled={busy !== null} onClick={() => void install(entry)}>
                  {installed ? "reinstall" : "install"}
                </button>
              )}
            </li>
          );
        })}
      </ol>

      {entries !== null && shown.length === 0 && entries.length > 0 && (
        <div className="pet-picker-note">nothing matches “{query}”</div>
      )}

      {/* Not decoration. Someone installing a stranger's drawing should be told
          whose it is and where it came from. */}
      <div className="pet-picker-foot">
        pets are community fan art, downloaded from the gallery to your machine. we render them; we
        do not host them.
      </div>
    </div>
  );
}
