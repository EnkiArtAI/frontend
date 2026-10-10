"use client";

import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import type { ImageViewSeed } from "@/lib/ui/image-view/seed";
import ImageViewDesktop from "./ImageViewDesktop";
import ImageViewMobile from "./ImageViewMobile";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { PHONE } from "@/lib/ui/kit/breakpoints";
import { useImageViewModel, type ImageViewModel } from "./useImageViewModel";
import "./image-view.css";

/**
 * The Image View: a prompt to generate with (the feed, the profile,
 * /generator/[id], /showcase), or the blank composer behind the launcher.
 * Every mount loads it client-only (next/dynamic, ssr: false). Leaving, by
 * any way out, unmounts it, and the render queue says where its renders went.
 */
export default function ImageView({ seed, onClose }: {
  seed: ImageViewSeed | "blank";
  /** The overlay's close. Absent on /generator/[id]: back, else home. */
  onClose?: () => void;
}) {
  const router = useRouter();
  const model = useImageViewModel(seed);
  const phone = useMediaQuery(PHONE);
  const leave = onClose ?? (() => (window.history.length > 1 ? window.history.back() : router.push("/home")));
  if (model.status !== "ready") return <PageState model={model} onBack={leave} />;
  return phone ? <ImageViewMobile model={model} onClose={leave} /> : <ImageViewDesktop model={model} onClose={leave} />;
}

function PageState({ model: m, onBack }: { model: ImageViewModel; onBack: () => void }) {
  if (m.status === "loading") {
    return (
      <div className="iv-state" role="status" aria-label="Loading">
        {m.title && <p className="kit-title iv-state-title">{m.title}</p>}
        <Loader2 className="iv-spin" size={26} aria-hidden />
      </div>
    );
  }
  return (
    <div className="iv-state">
      <p className="kit-title iv-state-title">{m.status === "gone" ? "This prompt isn't available" : "Couldn't load this prompt"}</p>
      <div className="iv-state-acts">
        {m.status === "failed" && <button type="button" className="iv-send" onClick={m.reload}>Try again</button>}
        <button type="button" className="iv-act" onClick={onBack}>Back</button>
      </div>
    </div>
  );
}
