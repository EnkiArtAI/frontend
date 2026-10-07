"use client";

import { useState } from "react";
import { Heart, Star, Bookmark, Play, Image as ImageIcon, Film, PencilLine } from "lucide-react";
import BookmarkPicker from "@/components/enki/BookmarkPicker";
import { useBetaAccess } from "@/components/BetaGate";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { preloadImageUI } from "@/components/enki/EnkiDetailPanel";
import type { EnkiPrompt } from "@/lib/enkiPromptAdapter";
import { openCreator } from "@/lib/openCreator";
import "./enki.css";

type EnkiCardProps = {
  prompt: EnkiPrompt;
  onOpen?: (prompt: EnkiPrompt) => void;
  onEdit?: (prompt: EnkiPrompt) => void;
};

export default function EnkiCard({ prompt, onOpen, onEdit }: EnkiCardProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  // The top-right action is a BOOKMARK now, not a like: it opens the
  // category picker and files the card there (Kev, 2026-08-22).
  const [pickerOpen, setPickerOpen] = useState(false);
  const { access, role } = useBetaAccess();
  const authed = access === "ok" && role !== "team";

  /* Warm what the click is about to need, while the pointer is still on its
     way: the image view's chunk, which next/dynamic otherwise fetches only on
     first render, and the two requests that view makes before it can paint.
     All three are idempotent, so hovering ten cards costs one chunk fetch and
     one models request. Failures are swallowed on purpose — this is an
     optimisation, and a broken one must never interfere with the click. */
  const warm = () => {
    preloadImageUI();
    queryClient.prefetchQuery({ queryKey: [`/api/prompts/${prompt.id}`] }).catch(() => {});
    queryClient.prefetchQuery({ queryKey: ["/api/models"] }).catch(() => {});
  };

  return (
    <article
      className="enki-card"
      onClick={() => onOpen?.(prompt)}
      onMouseEnter={warm}
      onFocus={warm}
    >
      <div className="enki-card-img">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={prompt.art.url} alt={prompt.title} />
        <span className={`enki-card-badge${prompt.isVideo ? " video" : " image"}`}>
          {prompt.isVideo ? <Film size={12} style={{ color: "var(--enki-ember)" }} /> : <ImageIcon size={12} style={{ color: "var(--enki-ink-3)" }} />}
          {prompt.isVideo ? "Video" : "Image"}
        </span>
        <div className="enki-card-tl-hover">
          {/* Rating first, likes second — the same order the image UI shows
              them (Kev, 2026-08-22). The heart used to print DOWNLOADS,
              a number wearing the wrong icon; it carries real likes now. */}
          <span className="enki-card-stat mono" title="Rating">
            <Star size={10} fill={prompt.rating > 0 ? "currentColor" : "none"} />
            {prompt.rating > 0 ? prompt.rating.toFixed(1) : "–"}
          </span>
          <span className="enki-card-stat mono" title="Likes">
            <Heart size={10} fill="currentColor" />
            {prompt.likes.toLocaleString()}
          </span>
          <span className="enki-card-stat mono enki-card-stat-price">${prompt.price.toFixed(2)}</span>
        </div>
        {/* Bookmarks are an ACCOUNT feature — a guest sees no button for a
            function that does not exist for them (Kev, 2026-08-24). */}
        {authed && (
        <button
          className={`enki-heart${pickerOpen ? " active" : ""}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setPickerOpen((o) => !o);
          }}
          type="button"
          aria-label="Bookmark this prompt"
          title="Bookmark"
        >
          <Bookmark size={14} fill={pickerOpen ? "currentColor" : "none"} />
        </button>
        )}
        {pickerOpen && (
          <BookmarkPicker
            promptId={prompt.id}
            imageUrl={prompt.art.url}
            onClose={() => setPickerOpen(false)}
          />
        )}
        {onEdit && (
          <button
            className="enki-edit"
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); onEdit(prompt); }}
            type="button"
            aria-label="Edit this prompt in the node editor"
            title="Edit in Create Prompt 2"
          >
            <PencilLine size={14} />
          </button>
        )}
        {prompt.isVideo && (
          <div className="enki-video-icon" aria-hidden="true">
            <Play size={14} fill="currentColor" />
          </div>
        )}
        <div className="enki-card-overlay">
          <div className="enki-card-overlay-bottom">
            <div className="enki-card-overlay-title serif">{prompt.title}</div>
            <div
              className="enki-card-overlay-artist mono"
              style={{ cursor: "pointer" }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (prompt.artist.id) {
                  openCreator(prompt.artist.handle || prompt.artist.id, router);
                }
              }}
            >
              {prompt.artist.name}
            </div>
          </div>
        </div>
      </div>
      <div className="enki-card-mobile-meta">
        <div className="enki-card-mobile-title serif">{prompt.title}</div>
        <div className="enki-card-mobile-row">
          <span
            style={{ cursor: "pointer" }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (prompt.artist.id) {
                openCreator(prompt.artist.handle || prompt.artist.id, router);
              }
            }}
          >
            {prompt.artist.name}
          </span>
          <span className="mono">${prompt.price.toFixed(2)}</span>
        </div>
      </div>
    </article>
  );
}
