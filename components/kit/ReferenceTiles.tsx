"use client";

import { useRef, useState, type CSSProperties, type DragEvent } from "react";
import { X } from "lucide-react";
import { dropSide, refRoom, refToken } from "@/lib/ui/kit/tile";
import "./kit-media.css";

export interface RefTile {
  id: string;
  src: string;
  /** The pill under the image: "Ref 1". */
  label?: string;
  /** Could not be read back: upload it again. */
  failed?: boolean;
  /** Its token is in the prompt. */
  used?: boolean;
  /** Beyond what the selected model takes: not sent. */
  over?: boolean;
}

/** A tile dragged to another place in the row, as opposed to into the prompt. */
const MOVE = "application/x-kit-ref";

/**
 * The reference images of a composer: the images, those still being read
 * (greyed, `enki-ref-pending`), and the tiles that add more, from files or
 * from the wallet's NFTs. The caller reads what is added (useReferenceReads)
 * and opens the NFT picker; this row hands over no more files than fit.
 */
export default function ReferenceTiles({
  items, pending, cap, accept, size, hint, onAddFiles, onRemove, onTileClick, onReorder, nft, dragToPrompt,
}: {
  items: RefTile[];
  /** Previews of images still being read (useReferenceReads().pending). */
  pending: string[];
  cap: number;
  /** The file types the model takes (useModelLimits().accept). */
  accept: string;
  size: 52 | 56 | 64;
  hint: string;
  onAddFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
  onTileClick?: (id: string) => void;
  /** Drag a tile onto another to move it there: "Reference image n" means the n-th. */
  onReorder?: (from: number, to: number) => void;
  /** Wallet NFTs as a link in the hint (desktop) or as a tile (phone). */
  nft?: { as: "link" | "tile"; onOpen: () => void };
  /** Tiles drag their [Reference image n] token into the prompt. */
  dragToPrompt?: { onStart: (token: string) => void; onEnd: () => void };
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [move, setMove] = useState<{ from: number; to: number | null } | null>(null);
  const room = refRoom(cap, items.length + pending.length);
  const drags = !!(onReorder || dragToPrompt);

  const start = (i: number) => (e: DragEvent) => {
    if (onReorder) {
      e.dataTransfer.setData(MOVE, String(i));
      setMove({ from: i, to: null });
    }
    if (dragToPrompt) {
      e.dataTransfer.setData("text/plain", refToken(i));
      dragToPrompt.onStart(refToken(i));
    }
    e.dataTransfer.effectAllowed = onReorder && dragToPrompt ? "copyMove" : onReorder ? "move" : "copy";
  };
  const over = (i: number) => (e: DragEvent) => {
    if (!move || !e.dataTransfer.types.includes(MOVE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (move.to !== i) setMove({ ...move, to: i });
  };
  const drop = (i: number) => (e: DragEvent) => {
    if (!move || !e.dataTransfer.types.includes(MOVE)) return;
    e.preventDefault();
    if (move.from !== i) onReorder?.(move.from, i);
    setMove(null);
  };
  const end = () => {
    setMove(null);
    dragToPrompt?.onEnd();
  };

  return (
    <div className="kit-refs kit-focus" style={{ "--kit-ref": `${size}px` } as CSSProperties}>
      <div className="kit-refs-head">
        <span className="kit-label">References</span>
        <span className="kit-refs-hint">
          {hint}
          {nft?.as === "link" && (
            <> · <button type="button" className="kit-refs-link" disabled={!room} onClick={nft.onOpen}>or pick an NFT</button></>
          )}
        </span>
      </div>
      <div className="kit-refs-row">
        {items.map((it, i) => (
          <div key={it.id} className="kit-ref" data-used={it.used || undefined} data-failed={it.failed || undefined}
            data-over={it.over || undefined}
            data-drop={move?.to === i ? dropSide(move.from, i) ?? undefined : undefined}
            draggable={drags} onDragStart={drags ? start(i) : undefined} onDragEnd={drags ? end : undefined}
            onDragOver={onReorder ? over(i) : undefined} onDrop={onReorder ? drop(i) : undefined}>
            {onTileClick ? (
              <button type="button" className="kit-ref-img" aria-label={it.label ?? `Reference ${i + 1}`} onClick={() => onTileClick(it.id)}>
                <img src={it.src} alt="" draggable={false} />
              </button>
            ) : (
              <span className="kit-ref-img"><img src={it.src} alt="" draggable={false} /></span>
            )}
            {it.label && <span className="kit-ref-label">{it.label}</span>}
            <button type="button" className="kit-ref-x kit-hit" aria-label={`Remove ${it.label ?? `reference ${i + 1}`}`}
              onClick={() => onRemove(it.id)}>
              <X size={11} strokeWidth={2.6} aria-hidden />
            </button>
          </div>
        ))}
        {pending.map((src) => (
          <div key={src} className="kit-ref">
            <span className="kit-ref-img enki-ref-pending"><img src={src} alt="" /></span>
          </div>
        ))}
        <button type="button" className="kit-ref-add kit-hit" disabled={!room} aria-label="Add reference images"
          onClick={() => picker.current?.click()}>
          <span className="kit-ref-glyph" aria-hidden>+</span>Add
        </button>
        {nft?.as === "tile" && (
          <button type="button" className="kit-ref-add kit-hit" disabled={!room} aria-label="Pick an NFT" onClick={nft.onOpen}>
            <span className="kit-ref-glyph" aria-hidden>◆</span>NFT
          </button>
        )}
        <input ref={picker} type="file" accept={accept} multiple hidden
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])].slice(0, room);
            e.currentTarget.value = "";
            if (files.length) onAddFiles(files);
          }} />
      </div>
    </div>
  );
}
