"use client";

/**
 * Vary in the editor: one AI roll of values for the draft's text variables
 * (create-desktop §3.8). Every roll is a paid xAI call, so the Image View has
 * none (plan R31). The draft is unsaved, so its variables travel with the
 * request; the answer is keyed by the ids sent, which are the names.
 */
import { useRef, useState } from "react";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { DICE_LIMITS } from "@/lib/generation/variable-dice";
import { notify } from "@/components/kit/notify";

/** `variables`: the names of the text variables to fill (checkboxes have no ticked state in the editor). */
export function useDiceRoll({ variables, context }: { variables: string[]; context: string }) {
  const [rolling, setRolling] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  // One roll at a time; a second click while in flight is a mash, not intent.
  const inFlight = useRef(false);

  /** The values that came back, or null when nothing should change. */
  const roll = async (): Promise<Record<string, string> | null> => {
    // The route needs a name on every variable and takes at most 24.
    const names = variables.filter(Boolean).slice(0, DICE_LIMITS.maxVariables);
    if (inFlight.current || unavailable) return null;
    if (!names.length) {
      notify("Add a [variable] first — the AI only fills in brackets");
      return null;
    }
    inFlight.current = true;
    setRolling(true);
    try {
      const res = await fetch("/api/workflow/variables", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({
          variables: names.map((name) => ({ id: name, name, label: name, type: "text" })),
          context: context.slice(0, DICE_LIMITS.maxContextLen),
        }),
      });
      if (res.status === 501) {
        // No XAI_API_KEY on this deployment: the button stays and goes quiet.
        setUnavailable(true);
        return null;
      }
      if (!res.ok) {
        notify(res.status === 429 ? "Vary is limited to 10 rolls a minute" : "Vary failed — your values are unchanged", { tone: "error" });
        return null;
      }
      const { values = {} } = (await res.json()) as { values?: Record<string, unknown> };
      return Object.fromEntries(Object.entries(values).filter((e): e is [string, string] => typeof e[1] === "string"));
    } catch {
      notify("Vary failed — your values are unchanged", { tone: "error" });
      return null;
    } finally {
      inFlight.current = false;
      setRolling(false);
    }
  };

  return { roll, rolling, unavailable };
}
