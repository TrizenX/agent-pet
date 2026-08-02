/**
 * Everything the pet says.
 *
 * In one place so a pack can override it and so translation is a data change
 * rather than a code change (§9.4). Deliberately terse: the bubble is a glance
 * target, not a message.
 */

import type { ToolKind } from "@agent-pet/protocol";
import type { PetState } from "./stateMap.ts";

export type Locale = "en" | "vi";

const LOCALES: readonly Locale[] = ["en", "vi"];

/**
 * Which language the pet speaks.
 *
 * An explicit choice wins; otherwise the webview's own locale decides. Empty is
 * deliberately distinct from `"en"` — it means nobody has chosen, which is what
 * lets someone on a Vietnamese system pick English and have it stick.
 */
export function resolveLocale(
  chosen: string,
  systemLocale = globalThis.navigator?.language ?? "",
): Locale {
  const pick = (tag: string): Locale | undefined =>
    LOCALES.find((l) => tag.toLowerCase().startsWith(l));
  return pick(chosen) ?? pick(systemLocale) ?? "en";
}

export const STRINGS: Readonly<Record<Locale, Partial<Record<PetState, string>>>> = {
  en: {
    attentive: "Hmm…",
    // The general case, for the gap between two tool calls. An activity refines
    // it whenever one is actually in flight.
    "working.generic": "On it!",
    "working.typing": "On it!",
    "working.digging": "On it!",
    "working.reading": "On it!",
    waiting_approval: "May I?",
    exhausted: "Out of puff…",
    error: "Oops!",
    celebrating: "Nailed it!",
  },
  vi: {
    attentive: "Ừm…",
    "working.generic": "Làm đây!",
    "working.typing": "Làm đây!",
    "working.digging": "Làm đây!",
    "working.reading": "Làm đây!",
    waiting_approval: "Cho phép nhé?",
    exhausted: "Hết pin rồi…",
    error: "Ui!",
    celebrating: "Ngon!",
  },
};

/**
 * What the pet says about the work in flight.
 *
 * Keyed by `ToolKind` — the protocol's own vocabulary — and never by an
 * adapter's `label`. A label would be agent-authored text arriving at runtime:
 * exactly the coupling I5 forbids, and exactly the kind the lint cannot catch,
 * because there would be no string in the source to grep for.
 *
 * Seven words, so a reader learns them once — and pet words rather than status
 * words. "Sniffing" for a search and "Fetching" for a download because the
 * thing on screen is an animal, not a progress bar. They still say what is
 * happening: a pet that is charming and uninformative is just clutter.
 */
export const ACTIVITY_STRINGS: Readonly<Record<Locale, Record<ToolKind, string>>> = {
  en: {
    bash: "Crunching…",
    file_edit: "Scribbling…",
    file_read: "Peeking…",
    search: "Sniffing…",
    network: "Fetching!",
    delegate: "Teamwork…",
    other: "Tinkering…",
  },
  vi: {
    bash: "Hì hục…",
    file_edit: "Nắn nót…",
    file_read: "Ngó tí…",
    search: "Đánh hơi…",
    network: "Tha về…",
    delegate: "Sai vặt…",
    other: "Loay hoay…",
  },
};

/**
 * States where naming the tool is the most useful thing the pet can say.
 *
 * Not every state. An approval outranks whatever tool triggered it, because the
 * pet is asking for something and that is the only thing worth reading. Same
 * for `error` and `exhausted`: the tool that failed is history.
 */
const ACTIVITY_STATES: ReadonlySet<PetState> = new Set<PetState>([
  "working.generic",
  "working.typing",
  "working.digging",
  "working.reading",
]);

export function speechFor(
  state: PetState,
  locale: Locale = "en",
  overrides?: Partial<Record<PetState, string>>,
  activity?: ToolKind | null,
): string | undefined {
  // A pack's override wins outright. Someone who wrote their own line for a
  // state meant it, including while a tool is running.
  const override = overrides?.[state];
  if (override) return override;

  if (activity && ACTIVITY_STATES.has(state)) {
    return ACTIVITY_STRINGS[locale][activity] ?? ACTIVITY_STRINGS.en[activity];
  }
  return STRINGS[locale][state] ?? STRINGS.en[state];
}
