"use client";

import { useState } from "react";
import { Globe } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { GenerationRow } from "@/lib/ui/image-view/history";
import { publicAsk, publicLabel } from "@/lib/ui/image-view/public-mark";

/**
 * The globe on one of the viewer's own images in the History: grey while it
 * is private, lit once it is public. A press asks first, in the editor's own
 * dialog; "yes" switches the image (lib/ui/image-view/public-mark).
 */
export default function PublicMark({ record, onSet }: {
  record: GenerationRow;
  onSet: (row: GenerationRow, on: boolean) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const isPublic = record.visibility === "public";
  const ask = publicAsk(isPublic);
  return (
    <>
      <button type="button" className="iv-hpub kit-hit" data-on={isPublic || undefined} aria-pressed={isPublic}
        aria-label={publicLabel(isPublic)} title={publicLabel(isPublic)}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        <Globe size={12} strokeWidth={2.2} aria-hidden />
      </button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{ask.title}</AlertDialogTitle>
            <AlertDialogDescription>{ask.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{ask.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onSet(record, !isPublic)}>{ask.ok}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
