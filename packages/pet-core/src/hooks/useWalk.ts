import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { stopListening } from "../events.ts";
import type { PetState } from "../packs/stateMap.ts";

/**
 * Telling the shell when to pace, and hearing back which way the pet is facing.
 *
 * The frontend deliberately does not drive the motion. It knows one thing the
 * shell does not — whether the agent is working — and sends exactly that, twice
 * per burst of work. Everything between those two messages happens in `walk.rs`,
 * because a window move per animation frame would be an IPC call per animation
 * frame, and I6 has already cost this project one polling loop.
 */

/** The pet paces while working and stands still everywhere else. */
function shouldWalk(state: PetState): boolean {
  return state.startsWith("working.");
}

export function useWalk(state: PetState, enabled: boolean): number {
  const [facing, setFacing] = useState(0);

  useEffect(() => {
    const unlisten = listen<number>("pet-walk", (e) => setFacing(e.payload));
    return () => stopListening(unlisten, "pet-walk");
  }, []);

  useEffect(() => {
    const on = enabled && shouldWalk(state);
    void invoke("set_walking", { on }).catch((e) => {
      console.warn(`[walk] set_walking(${on}) failed: ${e instanceof Error ? e.message : e}`);
    });
    if (!on) setFacing(0);
  }, [state, enabled]);

  return facing;
}
