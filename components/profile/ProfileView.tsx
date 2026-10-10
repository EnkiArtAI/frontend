"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveAccount } from "thirdweb/react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useCdpAddress } from "@/hooks/useCdpAddress";
import { useSolanaAuth } from "@/hooks/useSolanaAuth";
import { sessionAuthHeaders, viewerHeaders } from "@/lib/session-headers";
import EnkiCard from "@/components/enki/EnkiCard";
import EnkiDetailPanel from "@/components/enki/EnkiDetailPanel";
import { seedFromEnkiPrompt } from "@/lib/ui/image-view/seed";
import {
  mapMarketplacePromptToEnkiPrompt
} from "@/lib/enkiPromptAdapter";
import type { EnkiPrompt } from "@/lib/enkiPromptAdapter";
import { requestPromptEdit } from "@/components/enki-shell/editorBridge";
import { useBetaAccess } from "@/components/BetaGate";
import { openLogin } from "@/lib/openLogin";
import { listCreations, subscribeCreations, type StoredCreation } from "@/lib/creations";
import { useSearchParams, useRouter } from "next/navigation";
import { ArrowLeft, ChevronDown, Sparkles, ImageOff, User, Pencil, Loader2, ZoomIn, Heart, Flag } from "lucide-react";
import { ReportButton } from "@/components/ReportButton";
import "@/components/enki/enki.css";
import { encodeCanvas } from "@/lib/shrink-image";

const PROFILE_STAT_LABELS = ["Prompts", "Uses", "Followers", "This month"] as const;

type Me = {
  handle: string | null;
  bio: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  promptCount?: number | null;
};

/* ── Image focus editing ──────────────────────────────────────────────
   Banner and avatar are pan/zoomable in edit mode. z = 1 fits the image
   to the frame (full width first, never letterboxed), higher z zooms in.
   ox/oy are the image's top-left inside the frame, clamped so the frame
   stays covered; null means centered. On save the visible crop is baked
   into the uploaded file, so no focal metadata is stored anywhere. */
type ImgState = {
  src: string;
  iw: number;
  ih: number;
  z: number;
  ox: number | null;
  oy: number | null;
  changed: boolean;
};

const clampOff = (v: number, frame: number, size: number) => Math.min(0, Math.max(frame - size, v));

function imgLayout(s: ImgState, fw: number, fh: number) {
  const sc = Math.max(fw / s.iw, fh / s.ih) * s.z;
  const w = s.iw * sc;
  const h = s.ih * sc;
  return {
    sc, w, h,
    ox: clampOff(s.ox ?? (fw - w) / 2, fw, w),
    oy: clampOff(s.oy ?? (fh - h) / 2, fh, h),
  };
}

function loadImageState(src: string, changed = false): Promise<ImgState | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve({ src, iw: img.naturalWidth, ih: img.naturalHeight, z: 1, ox: null, oy: null, changed });
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function exportCrop(s: ImgState, fw: number, fh: number, outW: number, outH: number): Promise<File | null> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  const ok = await new Promise<boolean>((res) => {
    img.onload = () => res(true);
    img.onerror = () => res(false);
    img.src = s.src;
  });
  if (!ok || !img.naturalWidth) return null;
  const { sc, ox, oy } = imgLayout(s, fw, fh);
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, -ox / sc, -oy / sc, fw / sc, fh / sc, 0, 0, outW, outH);
  try {
    // WebP, or a JPEG on Safari, which encodes no WebP: labelled as what it is (lib/shrink-image).
    const blob = await encodeCanvas(canvas, 0.85);
    return blob ? new File([blob], `image.${blob.type.split("/")[1]}`, { type: blob.type }) : null;
  } catch {
    return null; // canvas tainted (source without CORS) — needs a fresh file
  }
}

/* avatar frame: 160px box minus the 8px border on each side */
const AVF = 144;

const heroBtn: React.CSSProperties = {
  height: 44, padding: "0 20px", borderRadius: 999,
  display: "inline-flex", alignItems: "center", gap: 8,
  fontSize: 14, fontWeight: 600, cursor: "pointer",
  background: "transparent", border: "1.5px solid var(--enki-rule)", color: "var(--enki-ink)",
};

const overlayChip: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6,
  fontSize: 12, fontWeight: 600, padding: "7px 12px", borderRadius: 999,
  background: "rgba(0,0,0,0.6)", color: "#fff", cursor: "pointer", border: "none",
};

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--enki-rule)",
  background: "var(--enki-paper-2)",
  color: "var(--enki-ink)",
  fontSize: 14,
  outline: "none",
};

/**
 * Edit profile — its own popup. Banner and avatar are pan/zoomable right in
 * the modal (drag to reposition, slider to zoom); the preview crops at the
 * same aspect ratio as the page banner, and the visible crop is baked into
 * the uploaded file on save.
 */
function EditProfileModal({ me, pageBannerW, pageBannerH, onClose, onSaved }: {
  me: Me;
  pageBannerW: number;
  pageBannerH: number;
  onClose: () => void;
  onSaved: (m: Me) => void;
}) {
  const [dHandle, setDHandle] = useState(me.handle ?? "");
  const [dBio, setDBio] = useState(me.bio ?? "");
  const [bannerImg, setBannerImg] = useState<ImgState | null>(null);
  const [avatarImg, setAvatarImg] = useState<ImgState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [fw, setFw] = useState(512); // measured modal banner width
  const dragRef = useRef<{ which: "banner" | "avatar"; startX: number; startY: number; ox: number; oy: number } | null>(null);

  // Banner preview height follows the page banner's aspect, so what you
  // frame here is exactly what the profile shows.
  const fh = Math.max(64, Math.round((fw * pageBannerH) / Math.max(320, pageBannerW)));
  const AVM = 128; // avatar preview frame (square)

  useEffect(() => {
    if (me.coverUrl) loadImageState(me.coverUrl).then(setBannerImg);
    if (me.avatarUrl) loadImageState(me.avatarUrl).then(setAvatarImg);
  }, [me.coverUrl, me.avatarUrl]);

  useEffect(() => {
    const measure = () => { if (frameRef.current) setFw(frameRef.current.clientWidth); };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const frameOf = (which: "banner" | "avatar"): [number, number] =>
    which === "banner" ? [fw, fh] : [AVM, AVM];

  const pickImage = (which: "banner" | "avatar") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    loadImageState(URL.createObjectURL(f), true).then((s) => {
      if (s) (which === "banner" ? setBannerImg : setAvatarImg)(s);
      else setErr("Couldn't read that image. Try a PNG, JPG or WebP.");
    });
  };

  const beginDrag = (which: "banner" | "avatar") => (e: React.PointerEvent) => {
    const s = which === "banner" ? bannerImg : avatarImg;
    if (!s) return;
    const [w, h] = frameOf(which);
    const l = imgLayout(s, w, h);
    dragRef.current = { which, startX: e.clientX, startY: e.clientY, ox: l.ox, oy: l.oy };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const s = d.which === "banner" ? bannerImg : avatarImg;
    if (!s) return;
    const [w, h] = frameOf(d.which);
    const l = imgLayout(s, w, h);
    (d.which === "banner" ? setBannerImg : setAvatarImg)({
      ...s,
      ox: clampOff(d.ox + e.clientX - d.startX, w, l.w),
      oy: clampOff(d.oy + e.clientY - d.startY, h, l.h),
      changed: true,
    });
  };
  const endDrag = () => { dragRef.current = null; };

  // Zoom around the frame center so the picture doesn't jump while zooming.
  const setZoom = (which: "banner" | "avatar", z: number) => {
    const s = which === "banner" ? bannerImg : avatarImg;
    if (!s) return;
    const [w, h] = frameOf(which);
    const before = imgLayout(s, w, h);
    const ratio = z / s.z;
    (which === "banner" ? setBannerImg : setAvatarImg)({
      ...s,
      z,
      ox: w / 2 - (w / 2 - before.ox) * ratio,
      oy: h / 2 - (h / 2 - before.oy) * ratio,
      changed: true,
    });
  };

  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      const fd = new FormData();
      const nh = dHandle.trim().toLowerCase();
      if (nh && nh !== (me.handle ?? "")) fd.append("handle", nh);
      if (dBio.trim() !== (me.bio ?? "").trim()) fd.append("bio", dBio);
      if (bannerImg?.changed) {
        const f = await exportCrop(bannerImg, fw, fh, 1600, Math.round((1600 * fh) / fw));
        if (!f) throw new Error("Couldn't process the banner. Pick the file again and retry.");
        fd.append("cover", f);
      }
      if (avatarImg?.changed) {
        const f = await exportCrop(avatarImg, AVM, AVM, 1024, 1024);
        if (!f) throw new Error("Couldn't process the picture. Pick the file again and retry.");
        fd.append("avatar", f);
      }
      if ([...fd.keys()].length === 0) { onClose(); return; }
      const res = await fetch("/api/users/profile", { method: "POST", headers: sessionAuthHeaders(), body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not save");
      onSaved(data as Me);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
      setBusy(false);
    }
  };

  const bannerL = bannerImg ? imgLayout(bannerImg, fw, fh) : null;
  const avatarL = avatarImg ? imgLayout(avatarImg, AVM, AVM) : null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 400, display: "flex",
        alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.45)", padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(600px, 100%)", maxHeight: "92vh", overflowY: "auto",
          background: "var(--enki-paper)", border: "1px solid var(--enki-rule)",
          borderRadius: 20, boxShadow: "0 30px 80px rgba(0,0,0,0.35)",
        }}
      >
        {/* Banner cropper */}
        <div
          ref={frameRef}
          style={{
            height: fh, borderRadius: "20px 20px 0 0", position: "relative", overflow: "hidden",
            background: "linear-gradient(135deg, var(--enki-paper-3), var(--enki-paper-2))",
            cursor: bannerImg ? "grab" : "default", touchAction: "none",
          }}
          onPointerDown={beginDrag("banner")}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
        >
          {bannerImg && bannerL && (
            <img
              src={bannerImg.src}
              alt=""
              draggable={false}
              style={{ position: "absolute", left: bannerL.ox, top: bannerL.oy, width: bannerL.w, height: bannerL.h, maxWidth: "none", userSelect: "none", pointerEvents: "none" }}
            />
          )}
          <label style={{ ...overlayChip, position: "absolute", top: 10, left: 10 }} onPointerDown={(e) => e.stopPropagation()}>
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={pickImage("banner")} style={{ display: "none" }} />
            <Pencil size={11} /> {bannerImg ? "Change banner" : "Add banner"}
          </label>
          {bannerImg && (
            <span
              style={{ ...overlayChip, position: "absolute", bottom: 10, right: 10, cursor: "default" }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <ZoomIn size={12} />
              <input
                type="range"
                min={1}
                max={4}
                step={0.01}
                value={bannerImg.z}
                onChange={(e) => setZoom("banner", Number(e.target.value))}
                style={{ width: 110, accentColor: "#fff" }}
                aria-label="Zoom banner"
              />
            </span>
          )}
        </div>
        {bannerImg && (
          <div style={{ padding: "6px 24px 0", fontSize: 11.5, color: "var(--enki-ink-3)" }}>
            Drag the banner to reposition it. The slider zooms.
          </div>
        )}

        <div style={{ padding: "0 24px 24px" }}>
          {/* Avatar cropper */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 14, marginTop: bannerImg ? 8 : -36 }}>
            <div style={{ position: "relative" }}>
              <div
                style={{
                  width: AVM + 10, height: AVM + 10, borderRadius: 26, overflow: "hidden",
                  background: "#111", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
                  border: "5px solid var(--enki-paper)", position: "relative",
                  cursor: avatarImg ? "grab" : "default", touchAction: "none",
                }}
                onPointerDown={beginDrag("avatar")}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
              >
                {avatarImg && avatarL ? (
                  <img
                    src={avatarImg.src}
                    alt=""
                    draggable={false}
                    style={{ position: "absolute", left: avatarL.ox, top: avatarL.oy, width: avatarL.w, height: avatarL.h, maxWidth: "none", userSelect: "none", pointerEvents: "none" }}
                  />
                ) : (
                  <User size={40} strokeWidth={1.5} />
                )}
              </div>
              <label
                style={{
                  position: "absolute", right: -4, bottom: -4, width: 30, height: 30, borderRadius: 10,
                  display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
                  background: "var(--enki-ink)", color: "var(--enki-paper)", border: "2px solid var(--enki-paper)",
                }}
                onPointerDown={(e) => e.stopPropagation()}
                title="Change picture"
              >
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={pickImage("avatar")} style={{ display: "none" }} />
                <Pencil size={13} />
              </label>
            </div>
            {avatarImg && (
              <div style={{ paddingBottom: 8 }}>
                <div style={{ fontSize: 11.5, color: "var(--enki-ink-3)", marginBottom: 4 }}>Drag to set the focus. Slider zooms.</div>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <ZoomIn size={13} style={{ color: "var(--enki-ink-3)" }} />
                  <input
                    type="range"
                    min={1}
                    max={4}
                    step={0.01}
                    value={avatarImg.z}
                    onChange={(e) => setZoom("avatar", Number(e.target.value))}
                    style={{ width: 150, accentColor: "var(--enki-ink)" }}
                    aria-label="Zoom picture"
                  />
                </span>
              </div>
            )}
          </div>

          <h2 className="serif" style={{ fontSize: 26, fontWeight: 400, margin: "14px 0 18px" }}><em>Edit profile</em></h2>

          <div style={{ display: "grid", gap: 14 }}>
            <div>
              <div className="mono" style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--enki-ink-3)", marginBottom: 6 }}>Username</div>
              <input
                value={dHandle}
                onChange={(e) => setDHandle(e.target.value)}
                maxLength={20}
                style={fieldStyle}
                placeholder="your_name"
              />
              <div style={{ fontSize: 12, color: "var(--enki-ink-3)", marginTop: 5 }}>
                3 to 20 characters. Letters, numbers or _
              </div>
            </div>
            <div>
              <div className="mono" style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--enki-ink-3)", marginBottom: 6 }}>Bio</div>
              <textarea
                value={dBio}
                onChange={(e) => setDBio(e.target.value)}
                maxLength={280}
                rows={4}
                style={{ ...fieldStyle, resize: "vertical", lineHeight: 1.5 }}
                placeholder="A visitor on the canvas of time."
              />
              <div style={{ fontSize: 12, color: "var(--enki-ink-3)", marginTop: 5, textAlign: "right" }}>
                {dBio.length}/280
              </div>
            </div>
          </div>

          {err && (
            <div style={{ marginTop: 12, fontSize: 13, color: "#c0392b" }}>{err}</div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
            <button style={{ ...heroBtn, height: 40 }} onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              style={{ ...heroBtn, height: 40, minWidth: 96, justifyContent: "center", background: "var(--enki-ink)", borderColor: "var(--enki-ink)", color: "var(--enki-paper)" }}
              onClick={save}
              disabled={busy}
            >
              {busy ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function useSafeActiveAccount() {
  try { return useActiveAccount(); } catch { return null; }
}

export default function ProfilePage({ onBack, isOwnProfile = true, handle }: { onBack?: () => void; isOwnProfile?: boolean; handle?: string } = {}) {
  /* ONE profile layout for everyone (Kev, 2026-08-24: "so ähnlich müssen
     auch andere profile angezeigt werden nur ohne deren likes"). `handle`
     switches this page to a FOREIGN view: same hero, same tabs minus the
     private ones, data loaded for that creator instead of the session. */
  const own = handle ? false : isOwnProfile;
  // History is a PRIVATE tab: only the profile owner sees it, never visitors.
  // Likes is PRIVATE like History: only the owner's view carries the tab,
  // and the route it reads derives the list from the SESSION — a visitor
  // cannot request anyone else's likes (Kev, 2026-08-23).
  /* Library is PRIVATE too (Kev, 2026-09-05): the owner's saved prompts and
     workflows, one click from the editor. */
  const TABS = own
    ? ["Released", "Gallery", "Library", "Likes", "Reviews", "About", "History"]
    : ["Released", "Gallery", "Reviews", "About"];
  const router = useRouter();
  const [activeTab, setActiveTab] = useState("Released");
  // The private Likes tab — fetched lazily the first time it opens.
  const [myLikes, setMyLikes] = useState<Array<{ promptId: string; title: string; imageUrl: string | null }> | null>(null);
  useEffect(() => {
    if (activeTab !== "Likes" || myLikes !== null) return;
    fetch("/api/prompts/likes/mine", { headers: viewerHeaders() })
      .then((r) => (r.ok ? r.json() : { likes: [] }))
      .then((d) => setMyLikes(d.likes ?? []))
      .catch(() => setMyLikes([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);
  // The private library — fetched lazily the first time its tab opens.
  type LibItem = { id: string; name: string; kind: string; updated_at: string; graph: unknown; prompt_text: string | null };
  const [library, setLibrary] = useState<LibItem[] | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const loadLibrary = async () => {
    setLibraryError(null);
    try {
      const r = await fetch("/api/library", { headers: { ...sessionAuthHeaders() } });
      const d = (await r.json().catch(() => ({}))) as { items?: LibItem[]; error?: string };
      if (!r.ok) { setLibrary([]); setLibraryError(d.error || `Couldn't load your library (HTTP ${r.status}).`); return; }
      setLibrary(Array.isArray(d.items) ? d.items : []);
    } catch { setLibrary([]); setLibraryError("Couldn't load your library."); }
  };
  useEffect(() => {
    if (activeTab !== "Library" || library !== null) return;
    void loadLibrary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);
  const deleteLibraryItem = async (id: string) => {
    const res = await fetch(`/api/library?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: { ...sessionAuthHeaders() } });
    if (res.ok) setLibrary((l) => (l ?? []).filter((x) => x.id !== id));
  };
  const [open, setOpen] = useState<EnkiPrompt | null>(null);
  const searchParams = useSearchParams();

  const account = useSafeActiveAccount();
  const { publicKey: solanaPublicKey } = useWallet();
  const { address: cdpAddress } = useCdpAddress();
  // Session-backed Solana identity: after a page load the wallet ADAPTER is
  // disconnected (autoConnect off) but the signed session lives on — without
  // it this page showed "Guest / not connected" to logged-in wallet users.
  const { isAuthenticated: solanaSessionActive, walletAddress: solanaSessionAddress } = useSolanaAuth();
  const walletAddress =
    account?.address ??
    (solanaSessionActive ? solanaSessionAddress : null) ??
    solanaPublicKey?.toBase58() ??
    cdpAddress ?? null;
  const isAuthed = !!walletAddress;

  // The user's name, bio and images live in the DB. The gate check already
  // fetched them at app boot, so the profile paints instantly from that cache
  // and only the prompt count arrives with the background refresh — no more
  // blank header or default-bio flash.
  const { setHandle: setSidebarHandle, profile: gateProfile, setProfile: setGateProfile } = useBetaAccess();
  const [me, setMe] = useState<Me | null>(!handle && gateProfile ? { ...gateProfile } : null);
  useEffect(() => {
    if (!handle && gateProfile) setMe((cur) => cur ?? { ...gateProfile });
  }, [gateProfile, handle]);

  /* Foreign profile: the creator's PUBLIC data, plus their payout wallet —
     which keys the gallery below (generations are stored by wallet). */
  const [creatorWallet, setCreatorWallet] = useState<string | null>(null);
  const [creatorId, setCreatorId] = useState<string | null>(null);
  useEffect(() => {
    if (!handle) return;
    let dead = false;
    (async () => {
      try {
        const res = await fetch(`/api/creators/${encodeURIComponent(handle)}/profile`, { headers: viewerHeaders() });
        if (!res.ok || dead) return;
        const d = await res.json();
        if (dead) return;
        setMe({
          handle: d.creator?.username ?? handle,
          bio: d.creator?.bio ?? null,
          avatarUrl: d.creator?.avatarUrl ?? null,
          coverUrl: d.creator?.coverImageUrl ?? null,
          promptCount: d.stats?.totalPrompts ?? 0,
        });
        setCreatorWallet(d.creator?.wallet ?? null);
        setCreatorId(d.creator?.id ? String(d.creator.id) : null);
      } catch { /* the empty hero stays until a retry */ }
    })();
    return () => { dead = true; };
  }, [handle]);

  // Clicking the banner or avatar opens it full-size in a lightbox.
  const [lightbox, setLightbox] = useState<string | null>(null);
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLightbox(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  // Edit profile pops its own UI (modal); the page banner is measured on open
  // so the modal's banner preview crops at the exact same aspect ratio.
  const [editOpen, setEditOpen] = useState(false);
  const bannerRef = useRef<HTMLDivElement | null>(null);
  const [pageBannerW, setPageBannerW] = useState(1200);
  const [pageBannerH, setPageBannerH] = useState(320);
  const startEdit = () => {
    if (!me) return;
    if (bannerRef.current) {
      setPageBannerW(bannerRef.current.clientWidth);
      setPageBannerH(bannerRef.current.clientHeight); // responsive height
    }
    setEditOpen(true);
  };
  useEffect(() => {
    if (handle) return; // foreign profile: the creator fetch above owns `me`
    if (!isAuthed) { setMe(null); return; }
    let dead = false;
    (async () => {
      try {
        const res = await fetch("/api/users/handle?stats=1", { headers: sessionAuthHeaders() });
        if (!res.ok) return; // the cached gate profile stays on screen
        const data = (await res.json()) as Partial<Me>;
        if (dead) return;
        const fresh: Me = {
          handle: data.handle ?? null,
          bio: data.bio ?? null,
          avatarUrl: data.avatarUrl ?? null,
          coverUrl: data.coverUrl ?? null,
          promptCount: data.promptCount ?? 0,
        };
        setMe(fresh);
        setGateProfile({ handle: fresh.handle, bio: fresh.bio, avatarUrl: fresh.avatarUrl, coverUrl: fresh.coverUrl });
      } catch { /* the cached gate profile stays on screen */ }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthed]);

  const displayName = me ? (me.handle ?? "Unnamed") : " ";
  // Every profile has a bio — new accounts start with the canvas line. While
  // nothing is loaded yet, show nothing instead of flashing the default line.
  const bio = me ? (me.bio && me.bio.trim()) || "A visitor on the canvas of time." : "";
  
  // Favorites logic (reused from feed)
  const [favs, setFavs] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try {
      return JSON.parse(localStorage.getItem("enki:favorites") || "{}");
    } catch {
      return {};
    }
  });

  const toggleFav = (id: string) => {
    setFavs((current) => {
      const next = { ...current, [id]: !current[id] };
      if (typeof window !== "undefined") {
        localStorage.setItem("enki:favorites", JSON.stringify(next));
      }
      return next;
    });
  };

  const { data, isError } = useQuery({
    queryKey: ["/api/marketplace/prompts", "profile", handle ?? "own"],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "20", sortBy: "newest" });
      // Foreign: only this creator's shelf — same query and mapping as the
      // feed, narrowed server-side by ?creator.
      if (handle) params.set("creator", handle);
      const res = await fetch(`/api/marketplace/prompts?${params.toString()}`, { headers: viewerHeaders(), credentials: "include" });
      if (!res.ok) throw new Error("Failed to load prompts");
      return res.json();
    },
    staleTime: 60_000,
  });

  const prompts = useMemo<EnkiPrompt[]>(() => {
    if (isError) return [];
    return Array.isArray(data?.prompts)
      ? data.prompts.map((item: unknown, index: number) => mapMarketplacePromptToEnkiPrompt(item, index))
      : [];
  }, [data, isError]);

  // Gallery state
  const [galleryItems, setGalleryItems] = useState<StoredCreation[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(true);

  /* The gallery's key: own view reads the session wallet, a foreign view
     reads the creator's public wallet from their profile. */
  const galleryWallet = handle ? creatorWallet : walletAddress;
  useEffect(() => {
    if (!galleryWallet) { setGalleryItems([]); setGalleryLoading(false); return; }
    let cancelled = false;
    const load = async () => {
      setGalleryLoading(true);
      // Local (unsynced) creations exist only for the device's own user.
      const local = handle ? [] : listCreations(galleryWallet);
      try {
        const res = await fetch(`/api/generations?userId=${encodeURIComponent(galleryWallet)}&limit=50`, { headers: viewerHeaders() });
        if (!res.ok) throw new Error("Failed");
        const json = await res.json();
        const raw = json?.data?.generations ?? json?.generations ?? json?.items ?? [];
        const gens = Array.isArray(raw) ? raw : [];
        const dbMapped = gens
          .filter((g: any) => g.image_urls?.length || g.image_url)
          .map((g: any) => ({
            id: String(g.id),
            imageUrl: g.image_urls?.[0] || g.image_url || "",
            prompt: g.final_prompt || g.prompt || "",
            createdAt: typeof g.created_at === "string" ? g.created_at : new Date().toISOString(),
            isUploaded: g.settings?.origin === "uploaded" || g.status === "uploaded",
          }));
        const dbUrls = new Set(dbMapped.map((c: any) => c.imageUrl));
        const localOnly = local.filter((c) => c.imageUrl && !dbUrls.has(c.imageUrl));
        const merged = [...dbMapped, ...localOnly].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        if (!cancelled) setGalleryItems(merged);
      } catch {
        if (!cancelled) setGalleryItems(local);
      } finally {
        if (!cancelled) setGalleryLoading(false);
      }
    };
    load();
    // Live refresh only for the device's own creations.
    const unsub = handle ? () => {} : subscribeCreations(galleryWallet, () => load());
    return () => { cancelled = true; unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [galleryWallet, handle]);

  // No profile for visitors — signed-out users get a login prompt instead.
  // A FOREIGN profile is public: guests may look at an artist's page.
  if (own && !isAuthed) {
    return (
      <div className="enki" style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ textAlign: "center", maxWidth: 380 }}>
          <h1 className="serif" style={{ fontSize: 34, fontWeight: 400, margin: "0 0 10px" }}><em>Your profile lives behind the door.</em></h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--enki-ink-3)", margin: "0 0 22px" }}>
            Log in and this page fills with your prompts, your gallery and your numbers.
          </p>
          <a href="/?login=1" onClick={(e) => { e.preventDefault(); openLogin(); }} style={{
            display: "inline-block", padding: "12px 26px", borderRadius: 12, textDecoration: "none",
            background: "linear-gradient(135deg,#d9863f,#e8a83a)", color: "#181209", fontSize: 14, fontWeight: 700,
          }}>
            Log in
          </a>
        </div>
      </div>
    );
  }

  return (
    /* .enki reserves 120px for the old fixed topbar — the profile starts at 0
       and brings its own slim X-style bar instead. */
    <div className="enki" style={{ paddingTop: 0 }}>
      {/* ─── Slim top bar: back arrow, name, prompt count ─── */}
      <div style={{
        position: "sticky", top: "var(--ek-page-top, 0px)", zIndex: 60, // below the 2FA bar outside the shell
        display: "flex", alignItems: "center", gap: 14,
        height: 52, padding: "0 12px",
        background: "color-mix(in oklab, var(--enki-paper) 84%, transparent)",
        backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
      }}>
        <button
          onClick={() => (onBack ? onBack() : window.history.back())}
          aria-label="Back"
          title="Back"
          style={{
            width: 36, height: 36, borderRadius: "50%", border: "none", cursor: "pointer",
            background: "transparent", color: "var(--enki-ink)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in oklab, var(--enki-ink) 9%, transparent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        >
          <ArrowLeft size={19} />
        </button>
        {me && (
          <div style={{ lineHeight: 1.25 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{me.handle ?? "Unnamed"}</div>
            <div style={{ fontSize: 11.5, color: "var(--enki-ink-3)" }}>
              {me.promptCount ?? 0} {me.promptCount === 1 ? "prompt" : "prompts"}
            </div>
          </div>
        )}
      </div>

      {/* ─── Profile Header Section ─── */}
      <div style={{ position: "relative" }}>
        {/* Banner — the user's own image, or the subtle pattern until they set one */}
        <div
          ref={bannerRef}
          style={{ height: "clamp(190px, 42vw, 320px)", background: "var(--enki-paper-3)", position: "relative", overflow: "hidden", cursor: me?.coverUrl ? "zoom-in" : undefined }}
          onClick={() => { if (me?.coverUrl) setLightbox(me.coverUrl); }}
        >
          {me?.coverUrl ? (
            <div style={{ position: "absolute", inset: 0, backgroundImage: `url(${me.coverUrl})`, backgroundSize: "cover", backgroundPosition: "center" }} />
          ) : (
            <div style={{
              position: "absolute",
              inset: 0,
              opacity: 0.1,
              backgroundImage: "radial-gradient(circle at 2px 2px, var(--enki-ink) 1px, transparent 0)",
              backgroundSize: "40px 40px"
            }} />
          )}
        </div>

        {/* Hero Content Container */}
        <div style={{
          maxWidth: 1400,
          margin: "0 auto",
          padding: "0 clamp(16px, 4vw, 40px)",
          position: "relative",
          marginTop: "clamp(-80px, -12vw, -44px)"
        }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: "clamp(14px, 3vw, 32px)", marginBottom: "clamp(20px, 4vw, 40px)", flexWrap: "wrap" }}>
            {/* Avatar — the user's image, or a plain user icon until they set one */}
            <div style={{
              width: "clamp(104px, 24vw, 160px)",
              height: "clamp(104px, 24vw, 160px)",
              borderRadius: 32,
              background: "#111",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              boxShadow: "0 20px 40px rgba(0,0,0,0.1)",
              border: "8px solid var(--enki-paper)",
              zIndex: 2,
              flexShrink: 0,
              cursor: me?.avatarUrl ? "zoom-in" : undefined
            }}
            onClick={() => { if (me?.avatarUrl) setLightbox(me.avatarUrl); }}
            >
              {me?.avatarUrl
                ? <img src={me.avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                : <User size={64} strokeWidth={1.25} />}
            </div>

            {/* Title & Actions */}
            <div style={{ flex: 1, paddingBottom: 10, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                <h1 className="serif" style={{ fontSize: "clamp(48px, 5vw, 72px)", fontWeight: 400, margin: 0, lineHeight: 1 }}>
                  <em>{displayName}</em>
                </h1>
                {/* Edit is the owner's; a foreign profile can be reported
                    (Message/Follow land as their own step). */}
                {own && (
                  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <button style={{ ...heroBtn, borderColor: "var(--enki-ink)" }} onClick={startEdit} disabled={!me}>
                      <Pencil size={15} /> Edit profile
                    </button>
                  </div>
                )}
                {!own && creatorId && (
                  <ReportButton targetType="user" targetId={creatorId} style={{ ...heroBtn, height: 40, padding: "0 16px", fontSize: 13 }}>
                    <Flag size={14} /> Report
                  </ReportButton>
                )}
              </div>
            </div>
          </div>

          {/* Bio & Stats — collapses to one column on narrow screens instead
              of squeezing the bio into a one-character waterfall. */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: "clamp(24px, 6vw, 80px)", marginBottom: "clamp(28px, 5vw, 60px)" }}>
            <div style={{ fontSize: 18, lineHeight: 1.6, color: "var(--enki-ink-3)", maxWidth: 640, fontStyle: "italic", minWidth: 0, overflowWrap: "anywhere" }}>
              {bio.slice(0, 280)}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "24px 40px" }}>
              {PROFILE_STAT_LABELS.map(label => (
                <div key={label}>
                  <div className="serif" style={{ fontSize: 32, lineHeight: 1, marginBottom: 4 }}>—</div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--enki-ink-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ─── Tabs & Filter Section ─── */}
      <div style={{ 
        borderTop: "1px solid var(--enki-rule)", 
        borderBottom: "1px solid var(--enki-rule)",
        background: "var(--enki-paper)",
        position: "sticky",
        top: "calc(52px + var(--ek-page-top, 0px))", // below the slim top bar
        zIndex: 40
      }}>
        <div style={{
          maxWidth: 1400,
          margin: "0 auto",
          padding: "0 clamp(16px, 4vw, 40px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "clamp(14px, 3vw, 32px)", flexWrap: "wrap" }}>
            {TABS.map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: "20px 0",
                  background: "none",
                  border: "none",
                  borderBottom: activeTab === tab ? "2px solid var(--enki-ink)" : "2px solid transparent",
                  color: activeTab === tab ? "var(--enki-ink)" : "var(--enki-ink-3)",
                  fontSize: 14,
                  fontWeight: activeTab === tab ? 600 : 400,
                  cursor: "pointer",
                  transition: "all 0.2s ease"
                }}
              >
                {tab}
                {tab === "Released" && prompts.length > 0 && (
                  <span className="mono" style={{ fontSize: 11, marginLeft: 8, opacity: 0.6 }}>{prompts.length}</span>
                )}
                {tab === "Gallery" && galleryItems.length > 0 && (
                  <span className="mono" style={{ fontSize: 11, marginLeft: 8, opacity: 0.6 }}>{galleryItems.length}</span>
                )}
              </button>
            ))}
            
            <button className="enki-catbar-all" style={{ height: 36, fontSize: 11, gap: 6, marginLeft: 16 }}>
              <Sparkles size={14} /> Filter by NFT <ChevronDown size={12} />
            </button>
          </div>

        </div>
      </div>

      {/* ─── Content Section ─── */}
      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "clamp(16px, 4vw, 40px)" }}>
        {activeTab === "Released" && prompts.length > 0 ? (
          <div className="enki-masonry">
            {prompts.map((prompt) => (
              <EnkiCard
                key={prompt.id}
                prompt={prompt}
                onOpen={setOpen}
                onEdit={own ? (p) => router.push(`/editor?id=${encodeURIComponent(p.id)}`) : undefined}
              />
            ))}
          </div>
        ) : activeTab === "Gallery" ? (
          galleryLoading ? (
            <div style={{ padding: "80px 0", textAlign: "center" }}>
              <div className="mono" style={{ fontSize: 13, color: "var(--enki-ink-3)" }}>Loading gallery…</div>
            </div>
          ) : galleryItems.length === 0 ? (
            <div style={{ padding: "80px 0", textAlign: "center" }}>
              <ImageOff size={32} color="var(--enki-ink-3)" style={{ margin: "0 auto 12px" }} />
              <div className="serif" style={{ fontSize: 24, color: "var(--enki-ink-3)" }}>
                No creations yet.
              </div>
              <p style={{ fontSize: 14, color: "var(--enki-ink-3)", marginTop: 8 }}>
                Generate an image or upload one and it will appear here.
              </p>
            </div>
          ) : (
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: 16,
            }}>
              {galleryItems.map((c) => (
                <div
                  key={c.id}
                  style={{
                    border: "1px solid var(--enki-rule)",
                    background: "var(--enki-paper)",
                    overflow: "hidden",
                  }}
                >
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
                  <div style={{ padding: 12 }}>
                    <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--enki-ink-3)" }}>
                      {new Date(c.createdAt).toLocaleDateString()}
                    </span>
                    <p style={{
                      margin: "4px 0 0", fontSize: 12, color: "var(--enki-ink-2)",
                      lineHeight: 1.5, maxHeight: 60, overflow: "hidden",
                      textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical",
                    }}>
                      {c.prompt}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : activeTab === "Library" ? (
          library === null ? (
            <div style={{ padding: "60px 0", textAlign: "center", color: "var(--enki-ink-3)" }}>Loading…</div>
          ) : libraryError ? (
            <div style={{ padding: "80px 0", textAlign: "center" }}>
              <div className="serif" style={{ fontSize: 24, color: "var(--enki-ink-3)" }}>Couldn't load your library.</div>
              <p style={{ fontSize: 14, color: "var(--enki-ink-3)", maxWidth: 440, margin: "8px auto 0" }}>{libraryError}</p>
              <button type="button" className="ek-btn" style={{ marginTop: 16, minHeight: 40 }} onClick={() => void loadLibrary()}>Try again</button>
            </div>
          ) : library.length === 0 ? (
            <div style={{ padding: "80px 0", textAlign: "center" }}>
              <div className="serif" style={{ fontSize: 24, color: "var(--enki-ink-3)" }}>Your library is empty.</div>
              <p style={{ fontSize: 14, color: "var(--enki-ink-3)", maxWidth: 440, margin: "8px auto 0" }}>
                Only you see this tab. In the prompt editor, choose “Save to my library” — saved prompts and workflows open here in one click and can be inserted into other prompts as workflow nodes.
              </p>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12, padding: "18px 0" }}>
              {library.map((it) => (
                <div key={it.id} style={{ border: "1px solid var(--enki-rule)", borderRadius: 12, background: "var(--enki-paper-2)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 14, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{it.name}</span>
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--enki-ink-3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{it.kind}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--enki-ink-3)", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{it.prompt_text || "—"}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                    <button type="button" className="ek-btn" style={{ minHeight: 32, flex: 1 }} onClick={() => requestPromptEdit({ title: it.name, libraryGraph: it.graph })}>Open in editor</button>
                    <button type="button" style={{ minHeight: 32, padding: "0 10px", border: "1px solid var(--enki-rule)", borderRadius: 8, background: "transparent", color: "var(--enki-ink-3)", cursor: "pointer" }} title="Delete from library" onClick={() => void deleteLibraryItem(it.id)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : activeTab === "Likes" ? (
          myLikes === null ? (
            <div style={{ padding: "60px 0", textAlign: "center", color: "var(--enki-ink-3)" }}>Loading…</div>
          ) : myLikes.length === 0 ? (
            <div style={{ padding: "80px 0", textAlign: "center" }}>
              <div className="serif" style={{ fontSize: 24, color: "var(--enki-ink-3)" }}>Nothing liked yet.</div>
              <p style={{ fontSize: 14, color: "var(--enki-ink-3)", maxWidth: 420, margin: "8px auto 0" }}>
                Only you see this tab. Tap the heart on any image and it lands here.
              </p>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12, padding: "18px 0" }}>
              {myLikes.map((l) => (
                <button key={l.promptId} type="button" onClick={() => router.push(`/generator/${l.promptId}`)}
                  style={{ padding: 0, border: "1px solid var(--enki-rule)", borderRadius: 12, overflow: "hidden", background: "var(--enki-paper-2)", cursor: "pointer", textAlign: "left" }}>
                  {l.imageUrl
                    ? <img src={l.imageUrl} alt={l.title} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} draggable={false} />
                    : <div style={{ width: "100%", aspectRatio: "1", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--enki-ink-3)" }}><Heart size={18} /></div>}
                  <div style={{ padding: "7px 9px", fontSize: 12.5, fontWeight: 600, color: "var(--enki-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.title}</div>
                </button>
              ))}
            </div>
          )
        ) : activeTab === "History" ? (
          <div style={{ padding: "80px 0", textAlign: "center" }}>
            <div className="serif" style={{ fontSize: 24, color: "var(--enki-ink-3)" }}>
              Your history is private.
            </div>
            <p style={{ fontSize: 14, color: "var(--enki-ink-3)", marginTop: 8, maxWidth: 420, margin: "8px auto 0" }}>
              Only you see this tab. It&apos;ll hold what you&apos;ve unlocked and generated over time.
            </p>
          </div>
        ) : (
          <div style={{ padding: "80px 0", textAlign: "center" }}>
            <div className="serif" style={{ fontSize: 24, color: "var(--enki-ink-3)" }}>
              Nothing to show in {activeTab} yet.
            </div>
          </div>
        )}
      </div>

      {/* ─── Modals ─── */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 500, padding: 24,
            background: "rgba(0,0,0,0.88)", cursor: "zoom-out",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="" style={{ maxWidth: "94vw", maxHeight: "94vh", objectFit: "contain", borderRadius: 8 }} />
        </div>
      )}
      {editOpen && me && (
        <EditProfileModal
          me={me}
          pageBannerW={pageBannerW}
          pageBannerH={pageBannerH}
          onClose={() => setEditOpen(false)}
          onSaved={(next) => {
            setMe({ ...next, promptCount: me?.promptCount ?? 0 });
            setGateProfile({ handle: next.handle, bio: next.bio, avatarUrl: next.avatarUrl, coverUrl: next.coverUrl });
            setSidebarHandle(next.handle);
            setEditOpen(false);
          }}
        />
      )}
      {open && (
        <EnkiDetailPanel
          seed={seedFromEnkiPrompt(open)}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
