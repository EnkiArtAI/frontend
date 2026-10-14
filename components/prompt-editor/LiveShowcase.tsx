"use client";

/**
 * The showcase a released prompt has now (E2), read-only: a listing-only
 * update keeps these, and a new release replaces them with the starred set.
 */
export default function LiveShowcase({ photos }: { photos: string[] }) {
  if (!photos.length) return null;
  return (
    <section className="pe-showcase" aria-label="Live images">
      <span className="kit-label">Live images</span>
      <div className="pe-showcase-row">
        {photos.slice(0, 4).map((src) => <img key={src} src={src} alt="" loading="lazy" />)}
      </div>
    </section>
  );
}
