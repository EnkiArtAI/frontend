"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { fitUpload } from "@/lib/shrink-image";
import {
  markThreadRead,
  refreshMessages,
  useMessages,
  type DmPeer,
  type DmThread,
} from "@/hooks/useMessages";

// Direct messages panel — implements the "Enki Messages" design: conversation
// list (search, unread pills) + thread view (date separators, bubbles, image
// and emoji composer). Data via /api/messages; list comes from the shared
// useMessages store, the open thread polls every 5s for new messages.

type Msg = { id: string; mine: boolean; body: string | null; imageUrl: string | null; at: string };

const EMOJIS = ["😀", "😂", "😍", "🤩", "😎", "🥹", "👍", "🙏", "🔥", "✨", "🎨", "🖼️", "💡", "❤️", "🎉", "👀", "💪", "🤝"];
const THREAD_POLL_MS = 5_000;
// Polls re-fetch a window BEFORE the newest seen created_at: created_at is
// txn-start time, so a slow commit can land "in the past" relative to what we
// already saw. The id-dedupe in apply() makes the overlap free.
const POLL_OVERLAP_MS = 20_000;

// Deterministic pastel per handle; color-mix keeps it readable in every theme.
const HUES = ["#e0584f", "#3b82c4", "#2f9e63", "#8b5cf6", "#d19a3a"];
const hueOf = (s: string) => HUES[[...s].reduce((n, c) => (n + c.charCodeAt(0)) % HUES.length, 0)];

function Avatar({ peer, size }: { peer: DmPeer; size: number }) {
  if (peer.avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={peer.avatarUrl} alt="" style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
    );
  }
  const base = peer.name || peer.handle || "?";
  const initials = base.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const h = hueOf(peer.handle ?? "?");
  return (
    <span
      style={{
        width: size, height: size, borderRadius: "50%", flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "var(--font-mono), monospace", fontSize: Math.round(size * 0.32), fontWeight: 700,
        background: `color-mix(in oklab, ${h} 20%, var(--enki-paper-2))`,
        color: `color-mix(in oklab, ${h} 65%, var(--enki-ink))`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${h} 38%, transparent)`,
      }}
    >
      {initials}
    </span>
  );
}

const HHMM = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const daysAgo = (iso: string) => {
  const d = new Date(iso), now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((day(now) - day(d)) / 86_400_000);
};
function dayLabel(iso: string): string {
  const diff = daysAgo(iso);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  const d = new Date(iso);
  if (diff < 7) return d.toLocaleDateString("en-US", { weekday: "long" });
  if (diff < 14) return "Last week";
  const label = d.toLocaleDateString("en-US", { day: "numeric", month: "long" });
  return d.getFullYear() === new Date().getFullYear() ? label : `${label} ${d.getFullYear()}`;
}
function rowTime(iso: string): string {
  const diff = daysAgo(iso);
  if (diff <= 0) return HHMM(iso);
  const d = new Date(iso);
  if (diff < 7) return d.toLocaleDateString("en-US", { weekday: "short" });
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short" });
}

const isNearBottom = (el: HTMLElement, slack = 320) =>
  el.scrollHeight - el.scrollTop - el.clientHeight < slack;

export default function MessagesPanel({ toast }: { toast?: (msg: string) => void }) {
  const { threads, loaded } = useMessages();
  const [activeId, setActiveId] = useState<string | null>(null);
  // A conversation just opened from search that the store poll hasn't seen yet.
  const [extraThread, setExtraThread] = useState<DmThread | null>(null);
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<DmPeer[] | null>(null);
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  // Bumped to force a full thread reload (e.g. expired signed image URLs).
  const [reloadNonce, setReloadNonce] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const lastAtRef = useRef<string | null>(null);
  const draftRef = useRef("");
  const draftsRef = useRef<Record<string, string>>({});
  const prevThreadRef = useRef<string | null>(null);
  const prevLenRef = useRef(0);
  const forceScrollRef = useRef(false);
  const imgReloadedRef = useRef(false);

  // Keep a ref mirror of the draft so effects can read it without re-running.
  const updateDraft = (v: string | ((d: string) => string)) => {
    setDraft((d) => {
      const nv = typeof v === "function" ? v(d) : v;
      draftRef.current = nv;
      return nv;
    });
  };

  // Default to the newest conversation, like the design.
  useEffect(() => {
    if (!activeId && loaded && threads.length) setActiveId(threads[0].id);
  }, [activeId, loaded, threads]);

  // Drop the placeholder once the store has caught up.
  useEffect(() => {
    if (extraThread && threads.some((t) => t.id === extraThread.id)) setExtraThread(null);
  }, [threads, extraThread]);

  const activeThread: DmThread | null =
    threads.find((t) => t.id === activeId) ?? (extraThread?.id === activeId ? extraThread : null);

  // Per-thread drafts: stash the old thread's draft, restore the new one, and
  // close the emoji popover — no message may ever go to the wrong recipient.
  useEffect(() => {
    const prev = prevThreadRef.current;
    if (prev && prev !== activeId) draftsRef.current[prev] = draftRef.current;
    prevThreadRef.current = activeId;
    updateDraft(draftsRef.current[activeId ?? ""] ?? "");
    setEmojiOpen(false);
  }, [activeId]);

  // Load the open thread, then poll incrementally (with a deduped overlap).
  useEffect(() => {
    if (!activeId) { setMsgs(null); return; }
    let dead = false;
    setMsgs(null);
    lastAtRef.current = null;
    prevLenRef.current = 0;
    imgReloadedRef.current = false;

    const apply = (list: Msg[], full: boolean) => {
      if (dead || (!full && !list.length)) return;
      setMsgs((prev) => {
        if (full || !prev) return list;
        const seen = new Set(prev.map((m) => m.id));
        const fresh = list.filter((m) => !seen.has(m.id));
        return fresh.length ? [...prev, ...fresh] : prev;
      });
      if (list.length) lastAtRef.current = list[list.length - 1].at;
      if (list.some((m) => !m.mine)) markThreadRead(activeId, lastAtRef.current);
    };

    // Resolves true only when the fetch really succeeded — markRead must
    // never fire off a failed or masked load.
    const load = async (after: string | null): Promise<boolean> => {
      try {
        const cursor = after ? new Date(Date.parse(after) - POLL_OVERLAP_MS).toISOString() : null;
        const url = `/api/messages?thread=${activeId}` + (cursor ? `&after=${encodeURIComponent(cursor)}` : "");
        const res = await fetch(url, { headers: sessionAuthHeaders() });
        if (!res.ok || dead) return false;
        const data = (await res.json()) as { messages?: Msg[] };
        apply(data.messages ?? [], !after);
        return true;
      } catch {
        return false; // next poll reconciles
      }
    };

    void load(null).then((ok) => {
      if (ok && !dead) markThreadRead(activeId, lastAtRef.current);
    });
    const iv = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void load(lastAtRef.current);
    }, THREAD_POLL_MS);
    return () => { dead = true; clearInterval(iv); };
  }, [activeId, reloadNonce]);

  // Keep the newest message in view — but never yank the user away from
  // reading history: only auto-scroll on first load, own sends, or when
  // they're already near the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || msgs === null) return;
    const initial = prevLenRef.current === 0 && msgs.length > 0;
    if (initial || forceScrollRef.current || isNearBottom(el)) el.scrollTop = el.scrollHeight;
    forceScrollRef.current = false;
    prevLenRef.current = msgs.length;
  }, [msgs?.length, msgs]);

  // People search (start new conversations) — debounced.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setPeople(null); return; }
    let dead = false;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`, { headers: sessionAuthHeaders() });
        if (!res.ok || dead) return;
        const data = (await res.json()) as { users?: DmPeer[] };
        if (!dead) setPeople(data.users ?? []);
      } catch { /* ignore */ }
    }, 250);
    return () => { dead = true; clearTimeout(t); };
  }, [query]);

  const appendMsg = (msg: Msg) => {
    forceScrollRef.current = true; // own sends always snap to the bottom
    setMsgs((prev) => (prev && !prev.some((m) => m.id === msg.id) ? [...prev, msg] : prev ?? [msg]));
    lastAtRef.current = msg.at;
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || !activeId || sending) return;
    setSending(true);
    setEmojiOpen(false);
    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ threadId: activeId, body: text }),
      });
      const data = await res.json().catch(() => ({} as { message?: Msg; error?: string }));
      if (!res.ok) { toast?.(data.error || "Could not send."); return; }
      updateDraft("");
      if (data.message) appendMsg(data.message);
      refreshMessages();
    } catch {
      toast?.("Could not send — check your connection."); // draft stays put
    } finally {
      setSending(false);
    }
  };

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).slice(0, 3);
    e.target.value = "";
    if (!files.length || !activeId || uploading) return;
    setUploading(true);
    try {
      for (const f of files) {
        // Made smaller until it arrives: Vercel turns away a body over 4.5 MB (lib/shrink-image).
        const fit = await fitUpload(f);
        if (!fit) { toast?.(`${f.name} is too large to send, even made smaller.`); continue; }
        try {
          const fd = new FormData();
          fd.append("threadId", activeId);
          fd.append("file", fit);
          const res = await fetch("/api/messages/image", { method: "POST", headers: sessionAuthHeaders(), body: fd });
          const data = await res.json().catch(() => ({} as { message?: Msg; error?: string }));
          if (!res.ok) { toast?.(data.error || "Could not send the image."); continue; }
          if (data.message) appendMsg(data.message);
        } catch {
          toast?.("Could not send the image — check your connection.");
        }
      }
      refreshMessages();
    } finally {
      setUploading(false);
    }
  };

  const openPerson = async (p: DmPeer) => {
    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ to: p.id }),
      });
      const data = await res.json().catch(() => ({} as { threadId?: string; peer?: DmPeer; error?: string }));
      if (!res.ok || !data.threadId) { toast?.(data.error || "Could not open the conversation."); return; }
      setQuery("");
      setPeople(null);
      if (!threads.some((t) => t.id === data.threadId)) {
        setExtraThread({ id: data.threadId, peer: data.peer ?? p, last: null, unread: 0 });
      }
      setActiveId(data.threadId);
      refreshMessages();
    } catch {
      toast?.("Could not open the conversation.");
    }
  };

  // A signed image URL expired (24h TTL): force one full reload per thread
  // view to re-sign everything.
  const onImgError = () => {
    if (imgReloadedRef.current) return;
    imgReloadedRef.current = true;
    setReloadNonce((n) => n + 1);
  };

  const q = query.trim().toLowerCase();
  const baseThreads = extraThread
    ? [extraThread, ...threads.filter((t) => t.id !== extraThread.id)]
    : threads;
  const visibleThreads = baseThreads.filter(
    (t) => !q || (t.peer.name ?? "").toLowerCase().includes(q) || (t.peer.handle ?? "").toLowerCase().includes(q),
  );
  const knownPeers = new Set(visibleThreads.map((t) => t.peer.id));
  const newPeople = (people ?? []).filter((p) => !knownPeers.has(p.id));

  const preview = (t: DmThread) =>
    t.last ? `${t.last.mine ? "You: " : ""}${t.last.body ?? "📷 Image"}` : "Say hi 👋";

  // Group messages under date separators, design-style.
  const msgRows: Array<{ sep: string } | { msg: Msg }> = [];
  let lastSep: string | null = null;
  for (const m of msgs ?? []) {
    const label = dayLabel(m.at);
    if (label !== lastSep) { lastSep = label; msgRows.push({ sep: label }); }
    msgRows.push({ msg: m });
  }

  return (
    <div className="ek-msg-root">
      {/* ── Conversation list ── */}
      <aside className="ek-msg-side">
        <div className="ek-msg-side-head">
          <h1 className="ek-msg-title"><em>Messages.</em></h1>
          <div className="ek-msg-search">
            <Icon name="search" size={13} stroke={2} />
            <input placeholder="Search people…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>
        <div className="ek-msg-convs">
          {!loaded ? (
            <div style={{ padding: "16px 10px", fontSize: 12.5, color: "var(--enki-ink-3)" }}>Loading…</div>
          ) : (
            <>
              {visibleThreads.map((t) => (
                <button key={t.id} className={"ek-msg-row" + (t.id === activeId ? " on" : "") + (t.unread ? " unread" : "")} onClick={() => setActiveId(t.id)}>
                  <Avatar peer={t.peer} size={38} />
                  <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                    <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                      <span className="ek-msg-row-name">{t.peer.name || t.peer.handle}</span>
                      {t.last && <span className="ek-msg-row-time">{rowTime(t.last.at)}</span>}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="ek-msg-row-prev">{preview(t)}</span>
                      {t.unread > 0 && <span className="ek-msg-pill">{t.unread}</span>}
                    </span>
                  </span>
                </button>
              ))}
              {newPeople.length > 0 && (
                <>
                  <div className="ek-msg-lab">Start new</div>
                  {newPeople.map((p) => (
                    <button key={p.id} className="ek-msg-row" onClick={() => void openPerson(p)}>
                      <Avatar peer={p} size={38} />
                      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                        <span className="ek-msg-row-name">{p.name || p.handle}</span>
                        <span className="ek-msg-row-prev" style={{ fontFamily: "var(--font-mono), monospace", fontSize: 10.5 }}>@{p.handle}</span>
                      </span>
                    </button>
                  ))}
                </>
              )}
              {visibleThreads.length === 0 && newPeople.length === 0 && (
                <div style={{ padding: "28px 14px", textAlign: "center", color: "var(--enki-ink-3)", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                  <Icon name="message" size={22} stroke={1.6} />
                  <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5 }}>
                    {q ? "No one found." : "No messages yet. Search above to find a creator and say hi."}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </aside>

      {/* ── Thread ── */}
      <section className="ek-msg-thread">
        {activeThread ? (
          <>
            <header className="ek-msg-thead">
              <button
                className="ek-msg-peer"
                title={`@${activeThread.peer.handle}`}
                onClick={() => toast?.("Creator profiles are coming soon.")}
              >
                <Avatar peer={activeThread.peer} size={34} />
                <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: 14, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {activeThread.peer.name || activeThread.peer.handle}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono), monospace", fontSize: 10, color: "var(--enki-ink-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    @{activeThread.peer.handle}
                  </span>
                </span>
              </button>
            </header>

            <div className="ek-msg-scroll" ref={scrollRef}>
              {msgs === null ? (
                <div style={{ padding: 16, fontSize: 12.5, color: "var(--enki-ink-3)" }}>Loading…</div>
              ) : msgs.length === 0 ? (
                <div style={{ margin: "auto", textAlign: "center", color: "var(--enki-ink-3)", fontSize: 12.5 }}>
                  Say hi to @{activeThread.peer.handle} 👋
                </div>
              ) : (
                msgRows.map((row, i) =>
                  "sep" in row ? (
                    <div key={`sep-${i}`} className="ek-msg-sep"><span>{row.sep}</span></div>
                  ) : (
                    <div key={row.msg.id} className={"ek-msg-item" + (row.msg.mine ? " mine" : "")} style={{ display: "flex", justifyContent: row.msg.mine ? "flex-end" : "flex-start" }}>
                      <div style={{ maxWidth: "min(64%, 620px)", display: "flex", flexDirection: "column", alignItems: row.msg.mine ? "flex-end" : "flex-start", gap: 3 }}>
                        {row.msg.imageUrl && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            className="ek-msg-img"
                            src={row.msg.imageUrl}
                            alt="Shared image"
                            loading="lazy"
                            onError={onImgError}
                            onLoad={() => {
                              const el = scrollRef.current;
                              if (el && isNearBottom(el)) el.scrollTop = el.scrollHeight;
                            }}
                          />
                        )}
                        {row.msg.body && <span className="ek-msg-bubble">{row.msg.body}</span>}
                        <span className="ek-msg-time">{HHMM(row.msg.at)}</span>
                      </div>
                    </div>
                  ),
                )
              )}
            </div>

            <div className="ek-msg-compose-wrap">
              {emojiOpen && (
                <div className="ek-msg-emoji">
                  {EMOJIS.map((ch) => (
                    <button key={ch} onClick={() => updateDraft((d) => d + ch)}>{ch}</button>
                  ))}
                </div>
              )}
              <div className="ek-msg-compose">
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" multiple style={{ display: "none" }} onChange={(e) => void onFiles(e)} />
                <button className="ek-msg-icon-btn" title="Send an image" disabled={uploading} onClick={() => fileRef.current?.click()}>
                  <Icon name="image" size={16} stroke={2} />
                </button>
                <button className={"ek-msg-icon-btn" + (emojiOpen ? " on" : "")} title="Emoji" onClick={() => setEmojiOpen((v) => !v)}>
                  <Icon name="smile" size={16} stroke={2} />
                </button>
                <input
                  type="text"
                  placeholder="Write a message…"
                  value={draft}
                  maxLength={2000}
                  onChange={(e) => updateDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // isComposing: Enter that commits an IME composition must not send.
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) void send();
                  }}
                />
                <button className={"ek-msg-send" + (draft.trim() ? " on" : "")} title="Send" onClick={() => void send()}>
                  <Icon name="send" size={14} stroke={2.2} />
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="ek-panel-stub" style={{ background: "transparent" }}>
            <Icon name="message" size={26} stroke={1.6} />
            <p>{loaded && threads.length === 0 ? "Your messages will appear here." : "Pick a conversation."}</p>
          </div>
        )}
      </section>
    </div>
  );
}
