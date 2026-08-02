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

  const fw = FRAME_WIDTH * scale;
  const fh = FRAME_HEIGHT * scale;
  useStepKeyframes(fw);

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
      data-state={state}
      data-substituted={resolved.substituted || undefined}
      style={{
        width: `${fw}px`,
        height: `${fh}px`,
        backgroundImage: `url(${pack.sheetUrl})`,
        backgroundSize: `${fw * COLUMNS}px ${fh * pack.geometry.rows}px`,
        backgroundPositionX: `${-frameIndex * fw}px`,
        backgroundPositionY: `${-resolved.row * fh}px`,
        transform: resolved.flip ? "scaleX(-1)" : undefined,
        animation: still
          ? "none"
          : `pet-step-${frames} ${(frames / fps).toFixed(3)}s steps(${frames}) ${
              anim.mode === "loop" ? "infinite" : "1 normal forwards"
            }`,
      }}
    />
  );
}
