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
    // The agent has replied and is waiting on you. In a list of sessions this
    // is the most actionable line there is — it says which ones want a human —
    // and it used to render as "…", because `idle` had no string at all.
    idle: "Your turn",
    sleeping: "Asleep",
    attentive: "Hmm…",
    // The gap between two tool calls, which is the model deciding what to do
    // next — so it says that. It used to say "On it!", which is the vaguest
    // possible answer to the one question the bubble exists to answer.
    "working.generic": "Thinking…",
    "working.typing": "Thinking…",
    "working.digging": "Thinking…",
    "working.reading": "Thinking…",
    "working.delegating": "Sent a friend…",
    compacting: "Tidying up…",
    waiting_input: "Well?",
    waiting_approval: "May I?",
    exhausted: "Out of puff…",
    error: "Oops!",
    celebrating: "Nailed it!",
  },
  /**
   * Spoken Vietnamese, not translated English.
   *
   * Three of these states all mean "a human is needed" and were saying so in
   * ways that blurred together — "Tới lượt bạn", "Sao nào?", "Cho phép nhé?".
   * In a list of five sessions the difference between them is the whole point,
   * so each now names what it actually wants: your next instruction, an answer,
   * or permission.
   *
   * "Nhờ bạn rồi…" was worse than flat, it was wrong — the pet had handed work
   * to a subagent and it read as though it were asking *you*.
   */
  vi: {
    idle: "Xong, tới bạn",
    sleeping: "Zzz…",
    attentive: "Để coi…",
    "working.generic": "Nghĩ tí…",
    "working.typing": "Nghĩ tí…",
    "working.digging": "Nghĩ tí…",
    "working.reading": "Nghĩ tí…",
    "working.delegating": "Gọi viện binh…",
    compacting: "Dọn trí nhớ…",
    waiting_input: "Đang hỏi bạn",
    waiting_approval: "Xin phép nha?",
    exhausted: "Hết pin rồi…",
    error: "Toang rồi!",
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
 * A verb, which the adapter's label completes: "Running" + "pnpm test".
 *
 * These were standalone words once — "Crunching…", "Hì hục…" — chosen to sound
 * like an animal rather than a progress bar. They were charming and they said
 * nothing, which is the worse failure of the two: the bubble exists to answer
 * "what is it doing", and "toiling away" is not an answer when the terminal
 * beside it already says the pet is busy.
 *
 * The trailing ellipsis lives in the no-label fallback, not here, so a labelled
 * line reads as a phrase rather than a trailing-off one.
 */
export const ACTIVITY_STRINGS: Readonly<Record<Locale, Record<ToolKind, string>>> = {
  en: {
    bash: "Running",
    file_edit: "Editing",
    file_read: "Reading",
    search: "Searching",
    network: "Fetching",
    delegate: "Delegating",
    other: "Working",
  },
  // One syllable wherever one will do, because the label after it is the part
  // worth reading. "Lục" for a search rather than "Tìm": it is what rummaging
  // through a codebase actually is, and "Lục TODO" says more than "Tìm TODO".
  vi: {
    bash: "Chạy",
    file_edit: "Sửa",
    file_read: "Đọc",
    search: "Lục",
    network: "Tải",
    delegate: "Nhờ",
    other: "Làm",
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
  // Not `working.delegating` or `compacting`: both already say something more
  // specific than the tool would.
]);

/**
 * The same states, said the way a pet would say them.
 *
 * Used when there is exactly one session. The terse table above is a column in
 * a table of five things and has to scan; this one has the whole bubble to
 * itself and can have a voice — it comments on the work instead of labelling
 * it. "Sửa engine.ts" tells you what happened. "Đụng vào engine.ts nè, hồi hộp
 * ghê" is a pet.
 *
 * `{}` is where the label goes. Templates rather than code so a pack can
 * override them and translation stays a data change (§9.4).
 */
const CHATTY: Readonly<Record<Locale, Partial<Record<PetState, string>>>> = {
  en: {
    idle: "All done — your move",
    sleeping: "Zzz…",
    attentive: "Let me have a think…",
    "working.delegating": "Called in some help",
    compacting: "Just tidying my memory",
    waiting_input: "Got a question for you",
    waiting_approval: "Mind if I do this one?",
    exhausted: "Out of puff — need a minute",
    error: "That went badly, sorry",
    celebrating: "Nailed it!",
  },
  vi: {
    idle: "Xong rồi, tới bạn nè",
    sleeping: "Zzz…",
    attentive: "Để mình coi đã…",
    "working.delegating": "Gọi viện binh rồi nè",
    compacting: "Dọn lại trí nhớ chút nha",
    waiting_input: "Mình hỏi bạn cái nè",
    waiting_approval: "Cho mình làm cái này nha?",
    exhausted: "Hết pin rồi, nghỉ tí",
    error: "Toang rồi, xin lỗi nha",
    celebrating: "Ngon lành!",
  },
};

const CHATTY_ACTIVITY: Readonly<Record<Locale, Record<ToolKind, string>>> = {
  en: {
    bash: "Running {} — hold on",
    file_edit: "Poking at {}, wish me luck",
    file_read: "Having a look at {}",
    search: "Digging around for {}",
    network: "Fetching {} now",
    delegate: "Getting {} to help",
    other: "Working on {}",
  },
  vi: {
    bash: "Chạy {} nè, chờ tí",
    file_edit: "Đụng vào {} nè, hồi hộp ghê",
    file_read: "Ngó {} xem sao",
    search: "Lục {} khắp nơi",
    network: "Tải {} về nè",
    delegate: "Nhờ {} phụ một tay",
    other: "Làm {} đây",
  },
};

export function speechFor(
  state: PetState,
  locale: Locale = "en",
  overrides?: Partial<Record<PetState, string>>,
  activity?: ToolKind | null,
  label?: string | null,
  /** One session on screen, so there is room for a voice. */
  chatty = false,
): string | undefined {
  // A pack's override wins outright. Someone who wrote their own line for a
  // state meant it, including while a tool is running.
  const override = overrides?.[state];
  if (override) return override;

  if (activity && ACTIVITY_STATES.has(state)) {
    if (chatty && label) {
      const template = CHATTY_ACTIVITY[locale][activity] ?? CHATTY_ACTIVITY.en[activity];
      return template.replace("{}", label);
    }
    const verb = ACTIVITY_STRINGS[locale][activity] ?? ACTIVITY_STRINGS.en[activity];
    // Without a label the verb has to stand alone, so it gets the ellipsis
    // back. With one, the label is the point.
    return label ? `${verb} ${label}` : `${verb}…`;
  }

  if (chatty) {
    const line = CHATTY[locale][state] ?? CHATTY.en[state];
    if (line) return line;
  }
  return STRINGS[locale][state] ?? STRINGS.en[state];
}
