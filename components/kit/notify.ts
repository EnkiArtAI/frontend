import { useEffect } from "react";
import { toast } from "@/hooks/use-toast";

/** The one way the image UI says something: the global toaster (2 s,
 *  bottom centre), which outlives the surface that spoke. */
export function notify(message: string, opts?: { tone?: "error" }): void {
  toast({ description: message, variant: opts?.tone === "error" ? "destructive" : "default" });
}

/** Lifts the toasts above a bottom bar while the caller is mounted;
 *  null leaves them where they are. */
export function useToastOffset(px: number | null): void {
  useEffect(() => {
    if (px === null) return;
    const style = document.documentElement.style;
    style.setProperty("--enki-toast-bottom", `${px}px`);
    return () => { style.removeProperty("--enki-toast-bottom"); };
  }, [px]);
}
