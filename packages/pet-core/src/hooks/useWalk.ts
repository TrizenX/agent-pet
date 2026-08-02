import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
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
 *
 * "Twice per burst" is enforced, not hoped for. The pet moves between working
 * substates on every tool call — digging to typing and back — and keying the
 * effect on the state would have sent one message per tool call while the
 * answer never changed.
 */

/** The pet paces while working and stands still everywhere else. */
function shouldWalk(state: PetState): boolean {
  return state.startsWith("working.");
}

export function useWalk(state: PetState, enabled: boolean): number {
  const [facing, setFacing] = useState(0);
  const sent = useRef<boolean | null>(null);

  useEffect(() => {
    const unlisten = listen<number>("pet-walk", (e) => setFacing(e.payload));
    return () => stopListening(unlisten, "pet-walk");
  }, []);

  useEffect(() => {
    const on = enabled && shouldWalk(state);
    if (sent.current === on) return;
    sent.current = on;

    // Turning it off because the user asked — reduced motion, or the tray
    // toggle — stops mid-stride. Turning it off because the work finished lets
    // the pet walk back. Someone who just said "stop moving" should not watch
    // two more seconds of moving.
    const command = on ? "set_walking" : enabled ? "set_walking" : "halt_walking";
    const args = on ? { on: true } : command === "set_walking" ? { on: false } : {};
    void invoke(command, args).catch((e) => {
      console.warn(`[walk] ${command} failed: ${e instanceof Error ? e.message : e}`);
    });
    if (!on) setFacing(0);
  }, [state, enabled]);

  return facing;
}
