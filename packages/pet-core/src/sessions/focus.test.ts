import { describe, expect, it } from "vitest";
import type { PetState } from "../packs/stateMap.ts";
import { focusLabel, needsAttention, pickFocus, type SessionView } from "./focus.ts";

function view(
  sessionId: string,
  state: PetState,
  lastEventAt: number,
  extra: Partial<SessionView> = {},
): SessionView {
  return {
    sessionId,
    source: "test",
    state,
    lastEventAt,
    blockedReason: null,
    activity: null,
    activityLabel: null,
    ...extra,
  };
}

describe("needsAttention", () => {
  it("covers exactly the states where the pet is asking for something", () => {
    expect(needsAttention("waiting_approval")).toBe(true);
    expect(needsAttention("exhausted")).toBe(true);
    for (const s of ["idle", "working.digging", "error", "celebrating", "sleeping"] as PetState[]) {
      expect(needsAttention(s), s).toBe(false);
    }
  });

  it("includes `waiting_input` — a question is a claim on the user too", () => {
    // Removing `waiting_input` from ATTENTION_STATES used to pass this whole
    // file. The state was added to the set in M5 and nothing here noticed,
    // which meant the feature — a question outranking a busier session — was
    // untested end to end.
    expect(needsAttention("waiting_input")).toBe(true);
  });

  it("ranks a question above a more recently active session", () => {
    const asking = view("a", "waiting_input", 1_000, { attentionSince: 1_000 });
    const busy = view("b", "working.digging", 9_000);

    expect(pickFocus([busy, asking])?.sessionId).toBe("a");
  });

  it("ranks whoever has been waiting longest, question or approval alike", () => {
    const question = view("a", "waiting_input", 5_000, { attentionSince: 2_000 });
    const approval = view("b", "waiting_approval", 5_000, { attentionSince: 4_000 });

    expect(pickFocus([approval, question])?.sessionId).toBe("a");
  });

  it("does not include `error`", () => {
    // `error` decays in three seconds and needs nothing from the user; treating
    // it as attention would let a transient failure outrank a real approval.
    expect(needsAttention("error")).toBe(false);
  });
});

describe("pickFocus", () => {
  it("returns nothing when there are no sessions", () => {
    expect(pickFocus([])).toBeNull();
  });

  it("shows the only session there is", () => {
    expect(pickFocus([view("a", "working.digging", 100)])?.sessionId).toBe("a");
  });

  it("prefers the most recently active session", () => {
    const picked = pickFocus([
      view("a", "working.digging", 100),
      view("c", "idle", 300),
      view("b", "working.typing", 200),
    ]);
    expect(picked?.sessionId).toBe("c");
  });

  it("attention outranks recency, however recent the other session is", () => {
    const picked = pickFocus([
      view("busy", "working.digging", 10_000),
      view("blocked", "waiting_approval", 1, { attentionSince: 1 }),
    ]);
    expect(picked?.sessionId).toBe("blocked");
  });

  it("picks whoever has been waiting longest", () => {
    const picked = pickFocus([
      view("recent", "waiting_approval", 900, { attentionSince: 900 }),
      view("oldest", "exhausted", 100, { attentionSince: 100 }),
      view("middle", "waiting_approval", 500, { attentionSince: 500 }),
    ]);
    expect(picked?.sessionId).toBe("oldest");
  });

  it("ranks by when attention began, not by last activity", () => {
    // A session that asked for approval long ago and has since received
    // unrelated chatter still outranks one that asked a moment ago.
    const picked = pickFocus([
      view("early-ask", "waiting_approval", 9_000, { attentionSince: 100 }),
      view("late-ask", "waiting_approval", 1_000, { attentionSince: 800 }),
    ]);
    expect(picked?.sessionId).toBe("early-ask");
  });

  it("treats an approval and a rate limit as equally deserving", () => {
    const picked = pickFocus([
      view("approval", "waiting_approval", 500, { attentionSince: 500 }),
      view("blocked", "exhausted", 200, { attentionSince: 200 }),
    ]);
    expect(picked?.sessionId).toBe("blocked");
  });

  it("breaks ties stably so the pet does not flicker", () => {
    const a = view("aaa", "idle", 100);
    const b = view("bbb", "idle", 100);
    expect(pickFocus([a, b])?.sessionId).toBe("aaa");
    expect(pickFocus([b, a])?.sessionId).toBe("aaa");
  });

  it("does not mutate the array it is given", () => {
    const sessions = [view("a", "idle", 1), view("b", "idle", 2)];
    const order = sessions.map((s) => s.sessionId);
    pickFocus(sessions);
    expect(sessions.map((s) => s.sessionId)).toEqual(order);
  });
});

describe("focusLabel", () => {
  it("stays quiet with a single session — the user knows what they are running", () => {
    expect(focusLabel(view("a", "idle", 1, { project: "acme-api" }), 1)).toBeUndefined();
  });

  it("names the project once more than one session is live", () => {
    expect(focusLabel(view("a", "idle", 1, { project: "acme-api" }), 3)).toBe("acme-api");
  });

  it("has nothing to say when there is no focus", () => {
    expect(focusLabel(null, 4)).toBeUndefined();
  });

  it("copes with an adapter that supplied no project", () => {
    expect(focusLabel(view("a", "idle", 1), 2)).toBeUndefined();
  });
});
