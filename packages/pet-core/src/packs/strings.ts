/**
 * Everything the pet says.
 *
 * In one place so a pack can override it and so translation is a data change
 * rather than a code change (§9.4). Deliberately terse: the bubble is a glance
 * target, not a message.
 */

import type { PetState } from "./stateMap.ts";

export type Locale = "en" | "vi";

export const STRINGS: Readonly<Record<Locale, Partial<Record<PetState, string>>>> = {
  en: {
    waiting_approval: "Approve?",
    exhausted: "Rate limited…",
    error: "Ouch.",
    celebrating: "Done!",
  },
  vi: {
    waiting_approval: "Duyệt nhé?",
    exhausted: "Hết lượt rồi…",
    error: "Á!",
    celebrating: "Xong!",
  },
};

export function speechFor(
  state: PetState,
  locale: Locale = "en",
  overrides?: Partial<Record<PetState, string>>,
): string | undefined {
  return overrides?.[state] ?? STRINGS[locale][state] ?? STRINGS.en[state];
}
