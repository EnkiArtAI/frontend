/**
 * The globe on one of the viewer's own images in the History (Kev,
 * 2026-10-13): grey while the image is private, lit once it is public. A
 * press asks first; "yes" switches it, and a public image stands under the
 * prompt as the next example (and on the profile) while it stays in the
 * History.
 */
export function publicAsk(isPublic: boolean): { title: string; text: string; ok: string; cancel: string } {
  return isPublic
    ? {
      title: "Make it private again?",
      text: "It leaves this prompt's images and your profile. Only you see it then.",
      ok: "Make private",
      cancel: "Keep public",
    }
    : {
      title: "Share this creation?",
      text: "It shows under this prompt and on your profile, so others can take inspiration from it. You can make it private again any time.",
      ok: "Make public",
      cancel: "Keep private",
    };
}

/** The mark's name for a screen reader and on hover. */
export const publicLabel = (isPublic: boolean) => (isPublic ? "Public · make it private" : "Private · share it");
