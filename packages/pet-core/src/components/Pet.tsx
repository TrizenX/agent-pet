import { useEffect, useMemo, useRef } from "react";
import { COLUMNS, FRAME_HEIGHT, FRAME_WIDTH } from "../packs/atlas.ts";
import { type LoadedPack, resolveRow } from "../packs/loader.ts";
import { type PetState, STATE_ANIMATIONS } from "../packs/stateMap.ts";

/**
 * One frame of the atlas, stepped with CSS.
 *
 * Frames advance by moving `background-position-x` under a `steps()` timing
 * function. Measured at 1.399 % of one core with the real 1536 × 1872 atlas
 * (M1 acceptance) — up from 0.2 % with the placeholder rectangle Spike C used,
 * which is the honest price of stepping a real sheet and still small enough
 * not to be the thing to optimise.
 */

const BASE_FPS = 8;

export interface PetProps {
  readonly pack: LoadedPack;
  readonly state: PetState;
  readonly scale: number;
  readonly reducedMotion: boolean;
  /** -1 walking left, 1 walking right, 0 standing still. */
  readonly facing?: number;
}

/**
 * `steps()` will not accept a custom property, so the keyframes have to exist
 * per frame count and per pixel width. There are at most eight of each, and
 * they are only regenerated when the scale changes.
 */
function useStepKeyframes(frameWidthPx: number): void {
  useEffect(() => {
    const id = "pet-step-keyframes";
    const el = document.getElementById(id) ?? document.createElement("style");
    el.id = id;
    el.textContent = Array.from({ length: COLUMNS }, (_, i) => i + 1)
      .map((n) => `@keyframes pet-step-${n}{to{background-position-x:${-n * frameWidthPx}px}}`)
      .join("");
    if (!el.isConnected) document.head.appendChild(el);
  }, [frameWidthPx]);
}

export function Pet({ pack, state, scale, reducedMotion, facing = 0 }: PetProps) {
  const anim = STATE_ANIMATIONS[state];
  /**
   * Walking left is a different row, not a mirrored one — when the pack drew
   * it. `resolveRow` already falls back to mirroring row 1 for packs that left
   * row 2 empty, which is most of the reason row 2 was worth using at all.
   *
   * Only while genuinely moving. A pet that is standing still should face
   * whichever way its idle art faces.
   */
  const row = facing < 0 && anim.row === "running-right" ? "running-left" : anim.row;
  const resolved = useMemo(() => resolveRow(pack, row), [pack, row]);

  /**
   * Every other working row has no left-facing twin, so mirror it.
   *
   * The pet paces in all four working states but only `working.digging` uses
   * `running-right`, so before this the other three walked left while still
   * drawn facing right — the window slid one way and the sprite moonwalked.
   * `resolveRow` may already have flipped a mirrored row 1; flipping twice
   * would face the wrong way, hence the xor.
   */
  const mirrored = facing < 0 && row === anim.row;
  const flip = resolved.flip !== mirrored;

  const fw = FRAME_WIDTH * scale;
  const fh = FRAME_HEIGHT * scale;
  useStepKeyframes(fw);

  // Everything that hangs off the pet — the bubble above its head, the badge
  // and the glyph at its shoulders — is positioned from these. The window is
  // sized for the largest pet at the tallest bubble, so anchoring to the window
  // instead leaves them floating in empty space around a small pet.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--pet-h", `${fh}px`);
    root.setProperty("--pet-w", `${fw}px`);
  }, [fh, fw]);

  // I6, and §7.4. A `sleeping` pet holds one frame with no animation at all —
  // not a slow one. `prefers-reduced-motion` gets the same treatment.
  const still = reducedMotion || anim.mode === "static" || anim.fpsScale === 0;
  const frames = Math.max(1, resolved.frames);
  const fps = BASE_FPS * anim.fpsScale;

  /**
   * Remount on every state change.
   *
   * A CSS animation does not restart when the element merely changes which
   * animation it is running, so without this a state change can inherit the
   * previous animation's progress and the pet visibly lags reality — which I3
   * exists to prevent.
   */
  const entry = useRef(0);
  const lastState = useRef(state);
  if (lastState.current !== state) {
    lastState.current = state;
    entry.current += 1;
  }

  const frameIndex = still ? Math.min(anim.staticFrame ?? 0, frames - 1) : 0;

  return (
    <div
      key={`${state}-${entry.current}`}
      className="pet-sprite"
      /* The drag handle is the pet itself, sized to it exactly. The window is
         far wider than the sprite so the speech bubble has room for a sentence,
         and putting the drag region on the root would make that whole invisible
         rectangle eat clicks meant for whatever is behind it. */
      data-tauri-drag-region
      data-state={state}
      data-substituted={resolved.substituted || undefined}
      style={{
        width: `${fw}px`,
        height: `${fh}px`,
        backgroundImage: `url(${pack.sheetUrl})`,
        backgroundSize: `${fw * COLUMNS}px ${fh * pack.geometry.rows}px`,
        backgroundPositionX: `${-frameIndex * fw}px`,
        backgroundPositionY: `${-resolved.row * fh}px`,
        transform: flip ? "scaleX(-1)" : undefined,
        animation: still
          ? "none"
          : `pet-step-${frames} ${(frames / fps).toFixed(3)}s steps(${frames}) ${
              anim.mode === "loop" ? "infinite" : "1 normal forwards"
            }`,
      }}
    />
  );
}
