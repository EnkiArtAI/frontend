"use client";

/**
 * Ratings & comments drawer for an OPENED prompt (Kev's model: a comment, a
 * rating, or a rating with a comment — one entry each). Self-contained: a
 * floating "★ 4.5 · 12" pill sits above the generate modal; tapping it opens
 * the panel with the star input, optional comment box and the list.
 * Data: /api/prompts/[id]/comments (GET public, POST session-required).
 */
import { useCallback, useEffect, useState } from "react";
import { MessageSquare, Star, X, Heart } from "lucide-react";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { failureSentence } from "@/lib/search/client";
import { useToast } from "@/hooks/use-toast";

interface CommentRow {
  id: string;
  handle: string;
  rating: number | null;
  body: string | null;
  createdAt: string;
}

export default function PromptEngagement({ promptId }: { promptId: string }) {
  const { toast } = useToast();
  const [openPanel, setOpenPanel] = useState(false);
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [stats, setStats] = useState<{ count: number; avgRating: number | null }>({ count: 0, avgRating: null });
  // Why the feedback could not load, never "No feedback yet".
  const [failed, setFailed] = useState<string | null>(null);
  // Likes ride the reactions table via /api/prompts/[id]/likes.
  const [likes, setLikes] = useState<{ count: number; mine: boolean }>({ count: 0, mine: false });
  const [liking, setLiking] = useState(false);
  const [myRating, setMyRating] = useState(0);
  const toggleLike = async () => {
    if (liking) return;
    setLiking(true);
    try {
      const res = await fetch(`/api/prompts/${encodeURIComponent(promptId)}/likes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d) setLikes({ count: d.count ?? 0, mine: !!d.mine });
      else if (res.status === 401) toast({ title: "Sign in to like." });
    } finally {
      setLiking(false);
    }
  };
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/prompts/${encodeURIComponent(promptId)}/comments`);
      fetch(`/api/prompts/${encodeURIComponent(promptId)}/likes`, { headers: { ...sessionAuthHeaders() } })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) setLikes({ count: d.count ?? 0, mine: !!d.mine }); })
        .catch(() => {});
      if (!res.ok) {
        setFailed(await failureSentence(res, "The feedback could not load"));
        return;
      }
      const data = await res.json();
      setFailed(null);
      setComments(data.comments ?? []);
      setStats(data.stats ?? { count: 0, avgRating: null });
    } catch { /* panel simply stays empty */ }
  }, [promptId]);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (!myRating && !body.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/prompts/${encodeURIComponent(promptId)}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({
          ...(myRating ? { rating: myRating } : {}),
          ...(body.trim() ? { body: body.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (res.status === 401) {
        toast({ title: "Sign in first", description: "Log in to rate or comment.", variant: "destructive" });
        return;
      }
      if (!res.ok) throw new Error(data?.error || "Could not save");
      setBody(""); setMyRating(0);
      toast({ title: data.updated ? "Rating updated" : "Thanks for your feedback!" });
      load();
    } catch (e) {
      toast({ title: "Couldn't save", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <>
      {/* Pill — always visible while a prompt is open */}
      <button
        onClick={() => setOpenPanel((o) => !o)}
        style={{
          position: "fixed", top: 76, right: 16, zIndex: 1600,
          display: "flex", alignItems: "center", gap: 6,
          padding: "8px 14px", borderRadius: 999, border: "1px solid var(--enki-rule, rgba(255,255,255,0.15))",
          background: "var(--enki-paper-2, #16161c)", color: "var(--enki-ink, #f5f2ec)",
          fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
        }}
      >
        <Star size={14} style={{ color: "#e8a83a", fill: stats.avgRating ? "#e8a83a" : "none" }} />
        {stats.avgRating ?? "–"}
        {/* Likes sit to the RIGHT of the rating (Kev, 2026-08-22) — same
            order as the card's chips. A span, not a nested button: the pill
            itself is the panel toggle. */}
        <span
          role="button"
          aria-label={likes.mine ? "Unlike" : "Like"}
          title={likes.mine ? "Unlike" : "Like"}
          onClick={(e) => { e.stopPropagation(); void toggleLike(); }}
          style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 6, cursor: "pointer" }}
        >
          <Heart size={13} style={{ color: "#e0584f", fill: likes.mine ? "#e0584f" : "none" }} />
          {likes.count}
        </span>
        <MessageSquare size={13} style={{ marginLeft: 4, opacity: 0.7 }} />
        {stats.count}
      </button>

      {openPanel && (
        <div
          style={{
            position: "fixed", top: 120, right: 16, zIndex: 1600, width: 340, maxWidth: "calc(100vw - 32px)",
            maxHeight: "70vh", display: "flex", flexDirection: "column",
            background: "var(--enki-paper-2, #16161c)", border: "1px solid var(--enki-rule, rgba(255,255,255,0.15))",
            borderRadius: 14, boxShadow: "0 20px 50px rgba(0,0,0,0.45)", color: "var(--enki-ink, #f5f2ec)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid var(--enki-rule, rgba(255,255,255,0.1))" }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>Ratings & comments</span>
            <button onClick={() => setOpenPanel(false)} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}>
              <X size={16} />
            </button>
          </div>

          {/* Input: stars + optional comment */}
          <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--enki-rule, rgba(255,255,255,0.1))" }}>
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} onClick={() => setMyRating(n === myRating ? 0 : n)}
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 2 }}>
                  <Star size={20} style={{ color: "#e8a83a", fill: n <= myRating ? "#e8a83a" : "none" }} />
                </button>
              ))}
              <span style={{ fontSize: 11, color: "var(--enki-ink-3, rgba(245,242,236,0.5))", alignSelf: "center", marginLeft: 6 }}>
                {myRating ? `${myRating}/5` : "optional"}
              </span>
            </div>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Say something about this prompt (optional)…"
              rows={2}
              maxLength={2000}
              style={{
                width: "100%", resize: "vertical", padding: "8px 10px", borderRadius: 8, fontSize: 13,
                border: "1px solid var(--enki-rule, rgba(255,255,255,0.15))", background: "transparent",
                color: "inherit", outline: "none",
              }}
            />
            <button
              onClick={submit}
              disabled={busy || (!myRating && !body.trim())}
              style={{
                marginTop: 8, width: "100%", padding: "9px 12px", borderRadius: 8, border: "none",
                background: busy || (!myRating && !body.trim()) ? "rgba(255,255,255,0.08)" : "linear-gradient(135deg,#d9863f,#e8a83a)",
                color: busy || (!myRating && !body.trim()) ? "rgba(245,242,236,0.4)" : "#181209",
                fontSize: 13, fontWeight: 700, cursor: "pointer",
              }}
            >
              {busy ? "Saving…" : myRating && body.trim() ? "Post rating + comment" : myRating ? "Post rating" : "Post comment"}
            </button>
          </div>

          {/* List */}
          <div style={{ overflowY: "auto", padding: "6px 0" }}>
            {comments.length === 0 ? (
              <p style={{ fontSize: 12.5, color: "var(--enki-ink-3, rgba(245,242,236,0.5))", padding: "10px 14px", margin: 0 }}>
                {failed ?? "No feedback yet. Be the first!"}
              </p>
            ) : (
              comments.map((c) => (
                <div key={c.id} style={{ padding: "10px 14px", borderBottom: "1px solid var(--enki-rule, rgba(255,255,255,0.06))" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                    <b>@{c.handle}</b>
                    {c.rating !== null && (
                      <span style={{ display: "inline-flex", gap: 1 }}>
                        {Array.from({ length: c.rating }, (_, i) => (
                          <Star key={i} size={11} style={{ color: "#e8a83a", fill: "#e8a83a" }} />
                        ))}
                      </span>
                    )}
                    <span style={{ marginLeft: "auto", color: "var(--enki-ink-3, rgba(245,242,236,0.4))", fontSize: 11 }}>
                      {new Date(c.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  {c.body && <p style={{ fontSize: 13, margin: "5px 0 0", lineHeight: 1.5 }}>{c.body}</p>}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}
