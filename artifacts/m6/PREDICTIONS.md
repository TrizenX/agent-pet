# Phase 2 — written before the adapter, so the result can disagree

§1.2: *"The architecture is adapter-based so Phase 2 and 3 are pure additions."*
§5.2: *"Phase 2 adds one line here. Nothing else in `pet-core` changes."*

Written at M0 and never tested — there has only ever been one adapter. A claim
nothing can falsify is not evidence, so here is what I expect to break, recorded
before writing a line of it.

1. **`hookConfig(endpoint): string` will not fit.** It returns JSON for an
   agent's settings file. Git hooks are executable shell scripts that have to
   land in `.git/hooks/`, per repository. The contract assumes configuration is
   a thing you paste.

2. **`copyHookConfig()` will produce nonsense.** It concatenates every adapter's
   block into one clipboard payload. With two adapters that is a JSON object
   glued to a shell script.

3. **The tray has one "Copy hook config" item.** Singular, for what is now a
   per-agent thing.

4. **`sessionId` is required and git has no sessions.** The repository path is
   the only stable candidate.

5. **The vocabulary is shaped like an LLM loop.** `TOOL_START`, `TURN_END`,
   `APPROVAL_NEEDED`. A commit is not a tool call. Either the mapping is
   semantically wrong or the wire format needs new types — and a new type means
   Phase 2 is not a pure addition.

If all five hold, the claim is false and the answer is a smaller contract. If
only the hook-config ones hold, the leak is in distribution and the core is
sound. Either is a result.
