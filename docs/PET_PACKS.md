# Authoring a pet pack

Agent Pet uses the community atlas format rather than one of its own, so a pack drawn for Petdex or ChatGPT's pet feature works here unchanged. This page covers the part that is ours: which rows we actually exercise, and what the pet does on top of them.

## The format

```
my-pet/
├── pet.json          { id, displayName, description?, spritesheetPath }
└── spritesheet.webp  (or .png)
```

| | v1 | v2 |
| :-- | :-- | :-- |
| Grid | 8 × 9 | 8 × 11 |
| Sheet | 1536 × 1872 | 1536 × 2288 |
| Frame | 192 × 208 | 192 × 208 |

Clean integer scales of either are accepted. Rows 9 and 10 of a v2 sheet are undocumented upstream and unused here.

Integer upscales of either grid are accepted, up to 4×. Past that a single sheet costs more memory than the whole app and the frame scan stalls the render thread, so it is refused with a reason rather than loaded slowly.

**Frame counts are per sheet, not per format.** Leave trailing cells transparent and the loader counts what is actually drawn — the common vector is `[6, 8, 8, 4, 5, 8, 6, 6, 6]`, but some packs pad every row to 8 and both work. Nothing is assumed; see [Spike D](../artifacts/spike-d/FINDINGS.md).

## Which rows the pet uses

| Row | Format name | Agent Pet draws it for | Notes |
| --: | :-- | :-- | :-- |
| 0 | `idle` | `idle` | |
| 1 | `running-right` | **`working.digging`** — a shell command | a real motion cycle reads as effort |
| 2 | `running-left` | *(reserved)* | synthesised by flipping row 1 if absent |
| 3 | `waving` | **`waiting_approval`** | the one state where the pet is asking for something — make it unmistakable |
| 4 | `jumping` | `attentive`, `celebrating` | |
| 5 | `failed` | `error`, `exhausted` | |
| 6 | `waiting` | `sleeping` | rendered as a single static frame, no animation |
| 7 | `running` | **`working.typing`** — a file edit, and any tool we did not classify | see below |
| 8 | `review` | **`working.reading`** — a file read or search | inspection reads best; a magnifier works well |

### Row 7 is worth a paragraph

Upstream documents it as a generic in-place run loop. In practice authors disagree: `frog` draws itself at a laptop, `slime` changes expression slightly, `boba` is near-indistinguishable from idle.

We use it for *typing*, because the authors who interpreted it drew working-at-a-computer. If you are drawing a pack for Agent Pet specifically, that is the reading to follow.

It is also the fallback for tool activity we could not classify, so in practice it is on screen more than any other working row. Worth more frames than its neighbours.

### Rows 3, 5 and 6 carry the most weight

They are the states a user needs to recognise without reading: waiting on me, broken, asleep. Row 0 and row 7 are ambient. Spend the effort on the first three.

## What we draw on top

A **state glyph** — ❓ for an approval, 🔋 for a rate limit, ⚠️ for an error, 🏆 for a celebration — composited in the corner with a matching glow.

This exists because body animation alone cannot carry state across a gallery of thousands of pets with wildly varying legibility, and because `error` and `exhausted` necessarily share row 5. **You do not need to draw these**, and you should not try to replace them: they are how the pet stays readable when the art is someone else's.

## Installing one

Drop the folder into any of:

```
~/Library/Application Support/dev.trizenx.agent-pet/packs/   (ours)
~/.petdex/pets/                                              (read-only to us)
~/.codex/pets/                                               (read-only to us)
```

Or just `npx petdex install <slug>`. Restart the pet and pick it from **Choose pet ▸** in the tray. A pack that fails to load is skipped with a reason in the event log; the built-in pet stays.

We never write to the two ecosystem directories. They belong to those tools.

## Licensing

Draw something you own. See [`IP_POLICY.md`](IP_POLICY.md).
