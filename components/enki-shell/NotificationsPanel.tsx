"use client";

/**
 * Notifications — the activity feed (comments, ratings, generations, guardian
 * answers). Paints instantly from the shared cache (useNotifications) and
 * refreshes in the background; opening marks everything seen (badge clears).
 *
 * Empty state: like X's starred suggestion, we surface one popular prompt so
 * the panel is never bare. If there are no prompts yet either, a friendly
 * placeholder shows instead.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { useNotifications, markNotificationsSeen, type Notif } from "@/hooks/useNotifications";
import { Icon } from "./icons";
import { promptPage } from "@/lib/ui/image-view/open-link";

const KIND_ICON: Record<string, string> = {
  comment: "message",
  rating: "sparkles",
  generation: "image",
  guardian_confirmed: "check",
  guardian_declined: "x",
};

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

type Suggested = { id: string; title: string; image: string | null };

function RecommendedEmpty() {
  const router = useRouter();
  const [rec, setRec] = useState<Suggested | null | undefined>(undefined); // undefined = loading

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const res = await fetch("/api/marketplace/prompts?limit=1&sortBy=trending", {
          headers: sessionAuthHeaders(),
        });
        const data = res.ok ? await res.json() : null;
        const p = data?.prompts?.[0];
        if (dead) return;
        setRec(p ? { id: String(p.id), title: p.title ?? "A prompt worth a look", image: p.previewImages?.[0] ?? null } : null);
      } catch {
        if (!dead) setRec(null);
      }
    })();
    return () => { dead = true; };
  }, []);

  if (rec === undefined) {
    return <div style={{ padding: "24px 40px", fontSize: 13, color: "var(--enki-ink-3)" }}>Loading…</div>;
  }

  if (!rec) {
    return (
      <div style={{ padding: "60px 40px", textAlign: "center", maxWidth: 520, margin: "0 auto" }}>
        <div className="serif" style={{ fontSize: 22, fontStyle: "italic", color: "var(--enki-ink-2)" }}>
          The Universe is preparing updates for you…
        </div>
      </div>
    );
  }

  // A single "recommended" card (starred), styled like a notification row.
  return (
    <div style={{ padding: "8px 40px 40px", maxWidth: 720 }}>
      <div className="mono" style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--enki-ink-3)", margin: "6px 0 10px" }}>
        Nothing new — here&apos;s one for you
      </div>
      <button
        onClick={() => router.push(promptPage(rec.id))}
        style={{
          display: "flex", alignItems: "center", gap: 14, width: "100%", textAlign: "left",
          padding: "14px 12px", borderRadius: 12, cursor: "pointer",
          border: "1px solid var(--enki-rule)", background: "color-mix(in oklab, var(--enki-ember) 6%, transparent)",
        }}
      >
        <span style={{
          width: 42, height: 42, borderRadius: 12, flexShrink: 0, overflow: "hidden",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "color-mix(in oklab, var(--enki-ember) 18%, transparent)", color: "var(--enki-ember)",
        }}>
          {rec.image
            ? /* eslint-disable-next-line @next/next/no-img-element */
              <img src={rec.image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            : <Icon name="sparkles" size={18} stroke={2} fill="currentColor" />}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <Icon name="sparkles" size={13} stroke={2} fill="var(--enki-ember)" style={{ color: "var(--enki-ember)" }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--enki-ink)" }}>Popular on Enki right now</span>
          </span>
          <span style={{ display: "block", fontSize: 12.5, color: "var(--enki-ink-3)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {rec.title}
          </span>
        </span>
      </button>
    </div>
  );
}

export default function NotificationsPanel({ onSeen, onOpenRecovery }: { onSeen?: () => void; onOpenRecovery?: () => void }) {
  const router = useRouter();
  const { items, unseen, loaded } = useNotifications();

  // Every notification links to its subject: guardian events → the guardian
  // settings, prompt events → that prompt's generator page.
  const targetOf = (n: Notif): (() => void) | null => {
    if (n.kind.startsWith("guardian_")) {
      return () => (onOpenRecovery ? onOpenRecovery() : router.push("/settings?tab=recovery"));
    }
    if (n.targetType === "prompt" && n.targetId) {
      const id = n.targetId;
      return () => router.push(promptPage(id));
    }
    return null;
  };

  // Reading the panel IS seeing them — clear up to the newest rendered item.
  useEffect(() => {
    if (!loaded) return;
    if (unseen > 0) markNotificationsSeen(items[0]?.createdAt ?? null);
    onSeen?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  if (!loaded) {
    return <div style={{ padding: "24px 40px", fontSize: 13, color: "var(--enki-ink-3)" }}>Loading…</div>;
  }

  if (items.length === 0) {
    return <RecommendedEmpty />;
  }

  return (
    <div style={{ padding: "8px 40px 40px", maxWidth: 720 }}>
      {items.map((n) => {
        const go = targetOf(n);
        return (
        <div
          key={n.id}
          onClick={go ?? undefined}
          role={go ? "link" : undefined}
          title={go ? (n.kind.startsWith("guardian_") ? "Open your guardian settings" : "Open this prompt") : undefined}
          style={{
            display: "flex", alignItems: "flex-start", gap: 14,
            padding: "14px 12px", borderBottom: "1px solid var(--enki-rule-2, var(--enki-rule))",
            background: n.seen ? "transparent" : "color-mix(in oklab, var(--enki-ember) 6%, transparent)",
            borderRadius: 10,
            cursor: go ? "pointer" : "default",
          }}
          onMouseEnter={(e) => { if (go) e.currentTarget.style.background = "color-mix(in oklab, var(--enki-ink) 6%, transparent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = n.seen ? "transparent" : "color-mix(in oklab, var(--enki-ember) 6%, transparent)"; }}
        >
          <span style={{
            width: 34, height: 34, borderRadius: 10, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "color-mix(in oklab, var(--enki-ink) 7%, transparent)", color: "var(--enki-ink-2)",
          }}>
            <Icon name={KIND_ICON[n.kind] ?? "sparkles"} size={16} stroke={2} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--enki-ink)", lineHeight: 1.35 }}>
              {n.title}
              {n.count > 1 && (
                <span style={{
                  marginLeft: 8, fontSize: 11, fontWeight: 700, padding: "1px 7px", borderRadius: 999,
                  background: "color-mix(in oklab, var(--enki-ember) 16%, transparent)", color: "var(--enki-ember)",
                }}>
                  ×{n.count}
                </span>
              )}
            </div>
            {n.body && <div style={{ fontSize: 12.5, color: "var(--enki-ink-3)", marginTop: 2 }}>{n.body}</div>}
          </div>
          <span style={{ fontSize: 11, color: "var(--enki-ink-3)", flexShrink: 0, marginTop: 2 }}>{timeAgo(n.createdAt)}</span>
        </div>
        );
      })}
    </div>
  );
}
