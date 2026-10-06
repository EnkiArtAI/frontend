"use client";
import { sessionAuthHeaders, viewerHeaders } from "@/lib/session-headers";
import { useActiveAccount } from "thirdweb/react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useMemo, useState } from "react";
import {
  clearCreations,
  listCreations,
  removeCreation,
  subscribeCreations,
  type StoredCreation,
} from "@/lib/creations";
import { WalletPickerModal } from "@/components/WalletPickerModal";
import { useCdpAddress } from "@/hooks/useCdpAddress";
import { usePasskey } from "@/hooks/usePasskey";
import { Images, Trash2, Wallet, Loader2, ImageOff } from "lucide-react";

type SupabaseGeneration = {
  id: string;
  image_url?: string;
  image_urls?: string[];
  final_prompt?: string | null;
  settings?: {
    origin?: string;
    [key: string]: any;
  };
  status?: string;
  created_at: string;
  visibility?: "public" | "private";
};

/** A DB image knows whether it is published; a local-only one has no such state. */
type GalleryItem = StoredCreation & { visibility?: "public" | "private"; isUploaded?: boolean };

export default function MyGalleryPage() {
  const account = useActiveAccount();
  const { connected: solanaConnected, publicKey: solanaPublicKey } = useWallet();
  const { address: cdpAddress } = useCdpAddress();
  const { stepUp } = usePasskey();
  const authenticated = !!account || solanaConnected || !!cdpAddress;
  const [showWalletPicker, setShowWalletPicker] = useState(false);
  const userKey = useMemo(
    () => account?.address ?? solanaPublicKey?.toBase58() ?? cdpAddress ?? null,
    [account?.address, solanaPublicKey, cdpAddress]
  );
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [mediaFilter, setMediaFilter] = useState<"all" | "images" | "videos">("all");

  // Listen for gallery refresh events
  useEffect(() => {
    const handleRefresh = () => {
      setRefreshTrigger((prev) => prev + 1);
    };

    window.addEventListener('gallery-refresh', handleRefresh);
    return () => window.removeEventListener('gallery-refresh', handleRefresh);
  }, []);

  useEffect(() => {
    if (!userKey) {
      setItems([]);
      return;
    }

    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      setFetchError(null);

      /* Always start with localStorage so wallet users always see their images */
      const local = listCreations(userKey);

      try {
        const res = await fetch(`/api/generations?userId=${encodeURIComponent(userKey)}&limit=100`, { headers: viewerHeaders() });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error || `Server responded with ${res.status}`);
        }
        const json = await res.json();
        /* Handle both direct shape and createSuccessResponse wrapper { data: { generations } } */
        const raw = json?.data?.generations ?? json?.generations ?? json?.items ?? [];
        const generations: SupabaseGeneration[] = Array.isArray(raw) ? raw : [];

        const dbMapped: GalleryItem[] = generations
          .filter((g) => g.image_urls?.length || g.image_url)
          .map((g) => {
            const imageUrl = g.image_urls && g.image_urls.length > 0
              ? g.image_urls[0]
              : g.image_url || "";
            const prompt = g.final_prompt || (g as any).prompt || "";
            return {
              id: String(g.id),
              imageUrl: String(imageUrl),
              prompt: typeof prompt === "string" ? prompt : "",
              createdAt: typeof g.created_at === "string" ? g.created_at : new Date().toISOString(),
              isUploaded: g.settings?.origin === "uploaded" || g.status === "uploaded",
              visibility: g.visibility === "public" ? "public" : "private",
            };
          });

        /* Merge: DB first, then local-only items not already in DB (dedup by imageUrl) */
        const dbUrls = new Set(dbMapped.map((c) => c.imageUrl));
        const localOnly = local.filter((c) => c.imageUrl && !dbUrls.has(c.imageUrl));
        const merged = [...dbMapped, ...localOnly].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );

        if (!cancelled) setItems(merged);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("Gallery fetch error:", message);
        /* On any DB error fall back to localStorage entirely */
        if (!cancelled) {
          setFetchError(message);
          setItems(local);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    load();

    const unsub = subscribeCreations(userKey, () => {
      load();
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [userKey, refreshTrigger]);

  const handleClear = () => {
    if (!userKey) return;
    clearCreations(userKey);
  };

  const handleRemove = async (id: string) => {
    if (!userKey) return;
    // Step-up 2FA (only prompts if the user enrolled a passkey; null otherwise).
    // A cancelled/failed passkey check aborts the delete.
    let stepUpToken: string | null;
    try {
      stepUpToken = await stepUp(`delete-work:${id}`);
    } catch {
      return;
    }
    try {
      await fetch(`/api/images/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { ...sessionAuthHeaders(), ...(stepUpToken ? { "X-StepUp-Token": stepUpToken } : {}) },
      });
    } catch {
      // ignore
    }
    removeCreation(userKey, id);
  };

  // Publish or unpublish one image (SHR-1); the list changes once the server agreed.
  const handleVisibility = async (id: string, visibility: "public" | "private") => {
    const res = await fetch(`/api/images/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify({ visibility }),
    }).catch(() => null);
    if (res?.ok) setItems((prev) => prev.map((c) => (c.id === id ? { ...c, visibility } : c)));
  };

  if (!authenticated || !userKey) {
    return (
      <div className="enki">
        <div className="enki-page-title" style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div className="enki-page-eyebrow">Private Collection</div>
          <h1 className="enki-page-h1">My Gallery</h1>
        </div>
        <main style={{ maxWidth: 1200, margin: "0 auto", padding: "0 40px 80px" }}>
          <div style={{
            border: "1px solid var(--enki-rule)",
            background: "var(--enki-paper-2)",
            padding: 48,
            textAlign: "center",
          }}>
            <Images size={40} color="var(--enki-ink-3)" style={{ margin: "0 auto 16px" }} />
            <p style={{ color: "var(--enki-ink-2)", fontSize: 15, margin: "0 0 20px" }}>
              Connect your wallet to view your private creations.
            </p>
            <button
              onClick={() => setShowWalletPicker(true)}
              style={{
                padding: "10px 24px", fontSize: 13, fontWeight: 600,
                background: "var(--enki-ink)", color: "#fff", border: "none",
                borderRadius: 4, cursor: "pointer",
                fontFamily: "var(--font-sans)",
                display: "inline-flex", alignItems: "center", gap: 8,
              }}
            >
              <Wallet size={14} /> Connect Wallet
            </button>
          </div>
        </main>
        <WalletPickerModal open={showWalletPicker} onClose={() => setShowWalletPicker(false)} />
      </div>
    );
  }

  const isVideo = (url: string) => /\.(mp4|webm|mov|avi)$/i.test(url);
  const filtered = mediaFilter === "all" ? items
    : mediaFilter === "images" ? items.filter(c => !isVideo(c.imageUrl))
    : items.filter(c => isVideo(c.imageUrl));

  return (
    <div className="enki">
      <WalletPickerModal open={showWalletPicker} onClose={() => setShowWalletPicker(false)} />

      {/* Page Header */}
      <div className="enki-page-title" style={{ maxWidth: 1200, margin: "0 auto" }}>
        <div className="enki-page-eyebrow">Private Collection</div>
        <h1 className="enki-page-h1">My Gallery</h1>
        <p className="enki-page-lede">Your generated and uploaded images. Only visible to you, unless you publish one.</p>
      </div>

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "0 40px 80px" }}>

        {/* Toolbar */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 16, flexWrap: "wrap", marginBottom: 24,
        }}>
          {/* Filter chips */}
          <div style={{ display: "flex", gap: 8 }}>
            {(["all", "images", "videos"] as const).map((filter) => (
              <button
                key={filter}
                onClick={() => setMediaFilter(filter)}
                data-testid={`button-filter-${filter}`}
                style={{
                  padding: "6px 14px", fontSize: 12, fontWeight: 500,
                  border: "1px solid var(--enki-rule)", borderRadius: 4,
                  background: mediaFilter === filter ? "var(--enki-ink)" : "transparent",
                  color: mediaFilter === filter ? "var(--enki-paper)" : "var(--enki-ink-2)",
                  cursor: "pointer", fontFamily: "var(--font-sans)",
                  textTransform: "capitalize",
                }}
              >
                {filter === "all" ? "All" : filter === "images" ? "Images" : "Videos"}
              </button>
            ))}
          </div>

          <button
            onClick={handleClear}
            disabled={items.length === 0}
            data-testid="button-clear-my-gallery"
            style={{
              padding: "6px 14px", fontSize: 12, fontWeight: 500,
              border: "1px solid var(--enki-rule)", borderRadius: 4,
              background: "transparent", color: "var(--enki-ink-2)",
              cursor: items.length === 0 ? "not-allowed" : "pointer",
              opacity: items.length === 0 ? 0.4 : 1,
              fontFamily: "var(--font-sans)",
              display: "inline-flex", alignItems: "center", gap: 6,
            }}
          >
            <Trash2 size={13} /> Clear All
          </button>
        </div>

        {/* Error Banner */}
        {fetchError && (
          <div style={{
            border: "1px solid var(--enki-ember)", background: "rgba(201,104,56,0.06)",
            padding: "12px 16px", borderRadius: 4, marginBottom: 20,
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
          }}>
            <p style={{ margin: 0, fontSize: 13, color: "var(--enki-ember)" }}>
              Failed to load gallery: {fetchError}
            </p>
            <button
              onClick={() => setRefreshTrigger(prev => prev + 1)}
              data-testid="button-retry-gallery"
              style={{
                padding: "4px 12px", fontSize: 12, fontWeight: 500,
                border: "1px solid var(--enki-rule)", borderRadius: 4,
                background: "transparent", color: "var(--enki-ink)",
                cursor: "pointer", fontFamily: "var(--font-sans)",
                whiteSpace: "nowrap",
              }}
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading */}
        {isLoading ? (
          <div style={{
            border: "1px solid var(--enki-rule)", background: "var(--enki-paper-2)",
            padding: 60, textAlign: "center", borderRadius: 4,
          }}>
            <Loader2 size={24} color="var(--enki-ink-3)" className="spin" style={{ animation: "spin 2s linear infinite", margin: "0 auto 12px" }} />
            <p style={{ margin: 0, fontSize: 13, color: "var(--enki-ink-3)" }}>Loading your gallery…</p>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        ) : filtered.length === 0 ? (
          /* Empty */
          <div style={{
            border: "1px solid var(--enki-rule)", background: "var(--enki-paper-2)",
            padding: 60, textAlign: "center", borderRadius: 4,
          }}>
            <ImageOff size={32} color="var(--enki-ink-3)" style={{ margin: "0 auto 12px" }} />
            <p style={{ margin: 0, fontSize: 14, color: "var(--enki-ink-2)" }}>
              No creations yet. Generate an image or upload one and it will appear here.
            </p>
          </div>
        ) : (
          /* Grid */
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 16,
          }}>
            {filtered.map((c) => (
              <div
                key={c.id}
                data-testid={`my-creation-${c.id}`}
                style={{
                  border: "1px solid var(--enki-rule)",
                  background: "var(--enki-paper)",
                  overflow: "hidden",
                }}
              >
                {/* Image */}
                <div style={{ aspectRatio: "4/3", position: "relative", overflow: "hidden", background: "var(--enki-paper-3)" }}>
                  <img
                    src={c.imageUrl}
                    alt={(c as any).isUploaded ? "Uploaded" : "Generated"}
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  />
                  {(c as any).isUploaded && (
                    <span style={{
                      position: "absolute", top: 8, left: 8,
                      fontSize: 9, fontFamily: "var(--font-mono)", letterSpacing: "1px",
                      textTransform: "uppercase",
                      background: "rgba(26,23,21,0.8)", color: "#fff",
                      padding: "3px 7px",
                    }}>
                      Uploaded
                    </span>
                  )}
                </div>

                {/* Meta */}
                <div style={{ padding: 14 }}>
                  <div style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    marginBottom: 8,
                  }}>
                    <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--enki-ink-3)" }}>
                      {new Date(c.createdAt).toLocaleDateString()}
                    </span>
                    <span style={{ display: "inline-flex", gap: 6 }}>
                    {c.visibility && !c.isUploaded && (
                      <button
                        onClick={() => handleVisibility(c.id, c.visibility === "public" ? "private" : "public")}
                        data-testid={`button-visibility-${c.id}`}
                        style={{
                          padding: "3px 8px", fontSize: 11, fontWeight: 500,
                          border: "1px solid var(--enki-rule)", borderRadius: 3,
                          background: c.visibility === "public" ? "var(--enki-ink)" : "transparent",
                          color: c.visibility === "public" ? "var(--enki-paper)" : "var(--enki-ink-2)",
                          cursor: "pointer", fontFamily: "var(--font-sans)",
                        }}
                      >
                        {c.visibility === "public" ? "Public" : "Publish"}
                      </button>
                    )}
                    <button
                      onClick={() => handleRemove(c.id)}
                      data-testid={`button-delete-creation-${c.id}`}
                      style={{
                        padding: "3px 8px", fontSize: 11, fontWeight: 500,
                        border: "1px solid var(--enki-rule)", borderRadius: 3,
                        background: "transparent", color: "var(--enki-ink-2)",
                        cursor: "pointer", fontFamily: "var(--font-sans)",
                      }}
                    >
                      Remove
                    </button>
                    </span>
                  </div>
                  <p style={{
                    margin: 0, fontSize: 12, color: "var(--enki-ink-2)",
                    lineHeight: 1.5, maxHeight: 72, overflow: "hidden",
                    textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical",
                  }}>
                    {c.prompt}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
