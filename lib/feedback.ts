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
