/**
 * Vercel turns away a request body over 4.5 MB before any route of ours
 * runs, with a 413 that is not JSON (vercel.com/docs/functions/limitations).
 * A paid generation would meet it only after its payment was signed, so a
 * body is measured before anything is sent or signed. 4 MB leaves room for
 * what the measure does not see: headers, the form around an upload, and
 * whether Vercel counts a megabyte as 1,000,000 bytes or 1,048,576.
 */
export const REQUEST_MAX_BYTES = 4_000_000;

/** Whether this body, sent as JSON, is too large to arrive. Counted in UTF-8 bytes, as it travels. */
export const tooLargeToSend = (body: unknown) => new Blob([JSON.stringify(body)]).size > REQUEST_MAX_BYTES;

export const SAVE_TOO_LARGE = "Your reference images are too large to save together. Remove some and save again. Nothing was saved.";
export const REFS_TOO_LARGE = "Your reference images are too large to send together. Remove some and try again. Nothing was generated and nothing was charged.";
