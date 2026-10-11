"use client";

import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import "@/components/image-view/image-view-frame.css";

/* Client-only, so a phone never paints the desktop layout first. */
const ImageView = dynamic(() => import("@/components/image-view/ImageView"), {
  ssr: false,
  loading: () => (
    <div className="iv-state" role="status" aria-label="Loading">
      <Loader2 className="iv-spin" size={26} aria-hidden />
    </div>
  ),
});

/**
 * The standalone prompt page: the Image View as the page, outside the shell.
 * It reads the prompt and its creator itself; page.tsx keeps the link
 * preview's head.
 */
export default function GeneratorClient() {
  const { id } = useParams<{ id: string }>();
  return (
    <main className="iv-page">
      <ImageView key={id} seed={{ promptId: id }} />
    </main>
  );
}
