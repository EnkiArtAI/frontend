"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { promptPage } from "@/lib/ui/image-view/open-link";
import "@/components/image-view/image-view-frame.css";

/**
 * A prompt's link opens the Image View inside the shell, beside its menu:
 * /generator/<id> goes straight on to /home?prompt=<id>. The view used to be
 * this page on its own, without the menu (Kev, 2026-10-13: "the left side bar
 * must be there EVERY TIME"). page.tsx keeps the link preview's head, which
 * the bots read without following this.
 */
export default function GeneratorClient() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(promptPage(id));
  }, [id, router]);
  return (
    <main className="iv-page">
      <div className="iv-state" role="status" aria-label="Loading">
        <Loader2 className="iv-spin" size={26} aria-hidden />
      </div>
    </main>
  );
}
