/**
 * Moderation evidence, and the part of it nobody reads (Kev, 2026-10-03:
 * "keiner darf künstlertexte sehen, außer admins und das auch nur die
 * wichtigsten, in harten grenzfällen").
 *
 * A record shows a moderator what they need to judge it: a user's own text,
 * a buyer's values. An artist's words never show. A refused save or an
 * editor preview keeps them apart as `withheld`; a block on a marketplace
 * prompt names the prompt instead of quoting it. Only the moderation owner
 * reveals either, one record at a time, for a logged reason (app/api/admin).
 *
 * Records are sealed under their own AAD, so no text anyone typed can pose
 * as one. A record without it predates this rule and shows as written,
 * unless it comes from a save or a generation: those may hold an artist's
 * words (a body, an editor's draft, a paid prompt's filled text) and stay
 * withheld whole.
 */
import { decryptString, encryptString, type EncryptedPayload } from "@/lib/crypto";

const AAD = "moderation-evidence/v1";
const MAX = 4000;
/** Where a record from before the rule may hold an artist's words. */
const LEGACY_ARTIST_SURFACES = ["upload", "generate-image", "generate-free"];
const mayHoldArtistText = (r: StoredEvidence) => LEGACY_ARTIST_SURFACES.includes(String(r.surface));

export interface Evidence {
  /** What every moderator may read. */
  shown: string;
  /** An artist's words: for the owner's reveal only. */
  withheld?: string;
  /** The marketplace prompt whose text the moderated request carried. */
  promptId?: string;
}

/** The record to store, or null when encryption is unavailable (the event is kept without it). */
export function sealEvidence(e: Evidence): EncryptedPayload | null {
  try {
    return encryptString(JSON.stringify({ shown: e.shown.slice(0, MAX), withheld: e.withheld?.slice(0, MAX), promptId: e.promptId }), AAD);
  } catch {
    return null;
  }
}

/** automod_events' evidence columns as read. */
export interface StoredEvidence {
  evidence_ct?: unknown;
  evidence_iv?: unknown;
  evidence_tag?: unknown;
  evidence_kid?: unknown;
  surface?: unknown;
}

function open(r: StoredEvidence, aad?: string): string | null {
  if (typeof r.evidence_ct !== "string" || !r.evidence_ct || typeof r.evidence_iv !== "string" || typeof r.evidence_tag !== "string") return null;
  try {
    return decryptString({ encrypted: r.evidence_ct, iv: r.evidence_iv, authTag: r.evidence_tag, kid: typeof r.evidence_kid === "string" ? r.evidence_kid : undefined }, aad);
  } catch {
    return null;
  }
}

function sealed(r: StoredEvidence): Evidence | null {
  const raw = open(r, AAD);
  if (raw === null) return null;
  const e = JSON.parse(raw) as Evidence;
  return { shown: String(e.shown ?? ""), withheld: e.withheld || undefined, promptId: e.promptId || undefined };
}

export interface EvidenceView {
  /** What the panel shows; null when there is nothing readable to show. */
  text: string | null;
  /** An artist's words belong to this record and are not shown. */
  withheld: boolean;
}

/** A record as every moderator sees it. */
export function readEvidence(r: StoredEvidence): EvidenceView {
  const e = sealed(r);
  if (e) return { text: e.shown || null, withheld: Boolean(e.withheld || e.promptId) };
  const legacy = open(r);
  if (legacy === null) return { text: null, withheld: false };
  return mayHoldArtistText(r) ? { text: null, withheld: true } : { text: legacy, withheld: false };
}

/** The withheld part of a record, for the owner's logged reveal and nothing else. */
export function withheldEvidence(r: StoredEvidence): { text: string | null; promptId: string | null } {
  const e = sealed(r);
  if (e) return { text: e.withheld ?? null, promptId: e.promptId ?? null };
  return { text: mayHoldArtistText(r) ? open(r) : null, promptId: null };
}
