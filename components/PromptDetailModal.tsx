"use client";

import React, { useEffect } from "react";
import dynamic from "next/dynamic";
import "./image-view/image-view-frame.css";

const ImageView = dynamic(() => import("./image-view/ImageView"), { ssr: false });

interface PromptData {
  id: string;
  title: string;
  artist: string;
  artistHandle?: string;
  imageUrl: string;
  thumbnailUrl?: string;
  showcaseImages?: any[];
  variables?: any[];
  price?: number;
  tags?: string[];
  createdAt?: string;
  uses?: number;
  isFree?: boolean;
}

interface PromptDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  prompt: PromptData | null;
}

export default function PromptDetailModal({ isOpen, onClose, prompt }: PromptDetailModalProps) {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [isOpen]);

  if (!isOpen || !prompt) return null;

  return (
    /* Same frame as EnkiDetailPanel. This surface renders outside the shell,
       where --ek-sw is undefined and the fallback of 0 keeps it full-width.
       The view draws its own Back and X. */
    <div className="iv-frame">
      <ImageView
        key={prompt.id}
        seed={{
          promptId: prompt.id,
          title: prompt.title,
          artist: { handle: prompt.artistHandle, name: prompt.artist },
          imageUrl: prompt.imageUrl,
          isFree: prompt.isFree,
        }}
        onClose={onClose}
      />
    </div>
  );
}
