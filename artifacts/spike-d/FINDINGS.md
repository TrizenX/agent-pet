# M0 · Spike D — Atlas layout, derived empirically

**Date:** 2026-08-01 · **Sheets analysed:** 5 (`boba` v2, `ghost` `cactus` `slime` `frog` v1) · **Manifest:** 4 289 pets, generated 2026-08-01T08:07:31Z

Reproduce:

```sh
python3 tools/spike-atlas/derive_atlas.py --out artifacts/spike-d --work /tmp/spike-d
python3 tools/spike-atlas/verify_rows.py  --out artifacts/spike-d --work /tmp/spike-d
```

**No third-party art is committed (D11).** The scripts download sheets to a scratch directory; only the derived numbers (`atlas-findings.json`, `row-verification.json`) and this document are tracked. The contact sheets and filmstrips referenced below are renderings of other people's pets — committing them to a public repo would be redistribution, so they are gitignored. Run the commands above to regenerate them locally.

---

## Verdict

**Spike D passes. D10 holds — adopt the format.** The atlas is usable for all ten of our states, with one correction to §12.3 and one correction to §12.1 (below).

---

## F1 — Row *order* is stable. Confirmed.

Nine rows, in this order, verified visually on every sheet:

| Row | Id | What the art actually shows |
| :-- | :-- | :-- |
| 0 | `idle` | Neutral pose, blink on a late frame |
| 1 | `running-right` | Run cycle, facing right |
| 2 | `running-left` | Row 1, mirrored |
| 3 | `waving` | Unmistakable raised-hand wave |
| 4 | `jumping` | Squash → lift → peak → descent → settle |
| 5 | `failed` | Unmistakable: tears, droop, sad face |
| 6 | `waiting` | Patient standing variant of idle |
| 7 | `running` | **See F5 — semantics vary by author** |
| 8 | `review` | Focused inspection; `frog` literally holds a magnifying glass |

## F2 — Frame *count* is per-sheet, not per-format. ⚠️ Spec change.

| Sheet | Frames per row |
| :-- | :-- |
| `frog`, `ghost`, `slime` | `[6, 8, 8, 4, 5, 8, 6, 6, 6]` ← modal |
| `boba` (v2) | `[7, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8]` |
| `cactus` | `[8, 8, 8, 8, 8, 8, 8, 8, 8]` — pads every row by repeating frames |

Three of four v1 sheets share the modal vector, but `cactus` pads to 8 everywhere and `boba` carries 7 on row 0. **The loader must count non-empty frames per row at load time and must never assume the modal vector.** A hardcoded table would render padding frames as real animation on `cactus` and truncate `boba`'s idle.

Detection rule that worked on all five sheets: a frame is live when alpha coverage > 0.1 %; frames are left-packed, so `frames = index(last live) + 1`.

## F3 — Rows 1 and 2 are a mirror pair. Confirmed.

Mean per-frame distance, row 1 vs row 2:

| Sheet | as-is | row 2 flipped | control (row 1 vs flipped row 5) |
| :-- | --: | --: | --: |
| `frog` | 0.0820 | **0.0011** | 0.0928 |
| `cactus` | 0.1366 | **0.0034** | 0.1452 |
| `boba` | 0.2135 | **0.0847** | 0.1566 |
| `ghost` | 0.2507 | 0.1881 | 0.2680 |
| `slime` | 0.2320 | 0.1683 | 0.2436 |

`frog` and `cactus` are near-pixel-perfect mirrors. The other three are directionally consistent (flipped distance always lower than as-is) but their art is asymmetric, so they are hand-drawn per direction rather than flipped.

Consequence: a pack missing row 2 can synthesise it by flipping row 1. Cheap fallback, worth having.

## F4 — v2 is v1 plus two rows. Confirmed.

`boba` (8×11, 1536×2288) matches the modal v1 reference on **8 of 9** rows; the only difference is row 0's frame count (F2, not a layout difference). Semantics match visually row for row — row 5 shows tears on both, row 3 waves on both.

Rows 9 and 10 carry 8 frames each and read as additional seated/idle poses. **Not named upstream, not used in Phase 1.** Treat v2 as v1 and ignore rows 9–10.

## F5 — ⚠️ Row 7's meaning is author-dependent. Risk.

Upstream's own state viewer documents row 7 as `running` — *"Generic in-place run loop."* The art disagrees:

- **`frog`**: sits at a **laptop**, typing. The author read "running" as *running code*.
- **`slime`**: subtle expression change; no activity cue at all.
- **`boba`**: holds its drink; near-indistinguishable from `idle`.

So row 7 cannot be relied on to read as any specific activity. Two consequences, both already in the design:

1. Use row 7 for `working.typing` anyway — where an author did interpret it, they interpreted it as *working at a computer*, which is exactly our meaning.
2. **This is the strongest argument yet for the §9.5 glyph layer.** Across a 4 289-pet gallery, body animation alone cannot carry state. The glyph is what makes §1.1's 200 ms glance test survive third-party art.

## F6 — Correction to §12.3

Evidence says swap `working.typing` and `working.digging`:

| Our state | v2.1 spec | **Corrected** | Why |
| :-- | :-- | :-- | :-- |
| `working.typing` | row 1 `running-right` | **row 7 `running`** | Authors draw row 7 as working-at-a-laptop (F5) |
| `working.digging` | row 7 `running` | **row 1 `running-right`** | Row 1 is a real motion cycle on every sheet; reads as effort |

Everything else in §12.3 is confirmed by the art: `waiting_approval` → 3 (wave), `error`/`exhausted` → 5 (unmistakable sad), `celebrating` → 4 (jump), `working.reading` → 8 (magnifier), `sleeping` → 6 (patient idle), `idle` → 0.

## F7 — Geometry validation

`1536×1872` → v1/9 rows and `1536×2288` → v2/11 rows both parse. Frame is `192×208` in both. Clean integer scales are accepted by dividing through; no scaled sheet appeared in the sample, so that path is covered by unit test only.

---

## Actions

| # | Action | Where |
| :-- | :-- | :-- |
| A1 | Loader counts live frames per row at runtime; no hardcoded frame table | `packs/atlas.ts` |
| A2 | Row order hardcoded as a 9-entry enum; v2 rows 9–10 ignored | `packs/atlas.ts` |
| A3 | Swap `typing`/`digging` rows | `packs/stateMap.ts`, spec §12.3 |
| A4 | Row 2 falls back to a horizontal flip of row 1 when absent | `packs/loader.ts` |
| A5 | Spec §12.1 amended: frame counts are per-sheet, modal vector is informational only | `PET_PROJECT_SPEC.md` |
| A6 | Glyph layer promoted from "nice" to load-bearing; cite F5 | spec §9.5 |
