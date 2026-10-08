/**
 * The "$100 for feedback" program's own rules, shared by the route that
 * stores a report (app/api/feedback), the modal that sends one and the admin
 * panel that decides on it. Nothing here may import server code: the modal
 * imports it too.
 */

/** The private bucket attachments are kept in; staff see them by signed link only. */
export const FEEDBACK_BUCKET = "feedback";
export const FEEDBACK_MAX_FILES = 5;
/** The attachment types a report may carry, each with the extension it is stored under. */
export const FEEDBACK_FILE_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
};
/** All attachments together. Vercel refuses a request body over 4.5 MB before
    the route runs, and the description and the form's framing ride in it too. */
export const FEEDBACK_MAX_BYTES = 4 * 1024 * 1024;

/** What a pick adds to the files already attached, and one sentence for each file left out. */
export function addFeedbackFiles(current: File[], picked: File[]): { files: File[]; refused: string[] } {
  const files = [...current];
  const refused: string[] = [];
  let total = files.reduce((n, f) => n + f.size, 0);
  for (const f of picked) {
    if (!Object.hasOwn(FEEDBACK_FILE_EXT, f.type)) refused.push(`“${f.name}” is not a PNG, JPG, WebP, GIF, MP4, WebM or MOV file.`);
    else if (files.length >= FEEDBACK_MAX_FILES) refused.push(`“${f.name}” is one too many: ${FEEDBACK_MAX_FILES} attachments at most.`);
    else if (total + f.size > FEEDBACK_MAX_BYTES) refused.push(`“${f.name}” does not fit: attachments can be ${FEEDBACK_MAX_BYTES / 1048576} MB in total.`);
    else { files.push(f); total += f.size; }
  }
  return { files, refused };
}

/**
 * feedback_submissions.status for each decision staff make, as the column's
 * CHECK constraint names them (probed live 2026-10-08: pending, reviewed,
 * accepted, rejected, paid, duplicate, spam). A new report is 'pending', the
 * column's default. Paid is no status: paid_at says it, on a report that is done.
 */
export const FEEDBACK_STATUS = { open: "pending", done: "accepted", rejected: "rejected" } as const;
export type FeedbackDecision = keyof typeof FEEDBACK_STATUS;

/** The decision a stored status stands for; a value this code never writes reads as open. */
export function feedbackDecision(status: unknown): FeedbackDecision {
  return (Object.keys(FEEDBACK_STATUS) as FeedbackDecision[]).find((k) => FEEDBACK_STATUS[k] === status) ?? "open";
}
