"use client";

import type { DragEvent } from "react";
import ReferenceTiles from "@/components/kit/ReferenceTiles";
import { parseTokens } from "@/lib/editor/prompt-tokens";
import type { EditorDoc, RefStore } from "@/lib/editor/undo";
import { refRoom } from "@/lib/ui/kit/tile";

/**
 * The prompt's reference images, "Ref n" each: the n-th is [Reference image n]
 * in the text. Every one is the creator's own image, used in the test renders
 * and saved with the prompt; there is no Mine / Theirs / Character badge
 * (plan §5 item 2). Image files dropped on the row are added like picked ones.
 */
export default function ReferenceStrip({ doc, refs, pending, cap, accept, nft, onAddFiles, onRemove, onTile, onNft, onDragToken }: {
  doc: EditorDoc;
  refs: RefStore;
  /** Previews still being read (useReferenceReads().pending). */
  pending: string[];
  /** What the test generator takes, and at most 14, what a prompt is saved with. */
  cap: number;
  accept: string;
  nft: "link" | "tile";
  onAddFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
  onTile: (id: string) => void;
  onNft: () => void;
  /** A tile's token is being dragged to the prompt; null when the drag ends. */
  onDragToken: (token: string | null) => void;
}) {
  const used = new Set(parseTokens(doc.prompt).flatMap((t) => (t.kind === "ref" ? [t.n] : [])));
  const items = doc.refIds.map((id, i) => {
    const r = refs[id];
    return { id, src: r?.data ?? r?.stored ?? "", label: `Ref ${i + 1}`, failed: r?.state === "failed", used: used.has(i + 1), over: i >= cap };
  });
  const n = items.length;
  const files = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const drop = (e: DragEvent) => {
    const images = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    e.preventDefault();
    const room = refRoom(cap, n + pending.length);
    if (room) onAddFiles(images.slice(0, room));
  };
  return (
    <div className="pe-refs" onDragOver={files} onDrop={drop}>
      <ReferenceTiles items={items} pending={pending} cap={cap} accept={accept} size={64}
        hint={n ? `${n} of ${cap} · used in your test renders, saved with the prompt` : "Add an image the AI should look at"}
        onAddFiles={onAddFiles} onRemove={onRemove} onTileClick={onTile}
        nft={{ as: nft, onOpen: onNft }}
        dragToPrompt={{ onStart: onDragToken, onEnd: () => onDragToken(null) }} />
    </div>
  );
}
