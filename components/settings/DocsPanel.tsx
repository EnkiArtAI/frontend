"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import SettingsSection from "./SettingsSection";
import { DOCS, FAQ } from "./docs-content";
import "./settings.css";

/* The "Where to ask" section closes the page as a footer line; everything
   else is a numbered section, then the FAQ. */
const MAIN = DOCS.filter((d) => d.id !== "help");
const HELP = DOCS.find((d) => d.id === "help");

/* Wherever the copy says "Settings, <tab>", the tab name becomes a link. */
const TAB_LINKS: Record<string, string> = { Profile: "profile", Payment: "payment", Referrals: "referrals", "Recovery & 2FA": "recovery" };
const TAB_RE = /Settings, (Recovery & 2FA|Profile|Payment|Referrals)/g;

function linkTabs(text: string, go: (id: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  TAB_RE.lastIndex = 0;
  for (let m = TAB_RE.exec(text); m; m = TAB_RE.exec(text)) {
    out.push(text.slice(last, m.index), "Settings, ",
      <button key={m.index} type="button" className="set-docs-link" onClick={() => go(TAB_LINKS[m[1]])}>{m[1]}</button>);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

const two = (n: number) => String(n).padStart(2, "0");

export default function DocsPanel({ onGoToTab }: { onGoToTab: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const hit = (...s: string[]) => !q || s.some((x) => x.toLowerCase().includes(q));
  const sections = MAIN.filter((d) => hit(d.title, d.summary, ...d.body));
  const faq = FAQ.filter((f) => hit(f.q, f.a));
  const help = HELP && hit(HELP.title, ...HELP.body) ? HELP : null;
  const toc = [
    ...sections.map((d) => ({ id: d.id, title: d.title })),
    ...(faq.length ? [{ id: "faq", title: "Questions" }] : []),
    ...(help ? [{ id: help.id, title: help.title }] : []),
  ];

  // Highlight the section being read: the last one whose top has crossed the
  // upper third of the viewport (so the FAQ wins at the page bottom too).
  const mainRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(MAIN[0].id);
  useEffect(() => {
    const els = Array.from(mainRef.current?.querySelectorAll<HTMLElement>("[data-doc]") ?? []);
    if (!els.length) return;
    setActive(els[0].dataset.doc!);
    const seen = new Set<string>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.doc!;
        if (e.isIntersecting) seen.add(id); else seen.delete(id);
      }
      const last = els.filter((el) => seen.has(el.dataset.doc!)).pop();
      if (last) setActive(last.dataset.doc!);
    }, { rootMargin: "0px 0px -67% 0px" });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [q]);

  const jump = (id: string) => document.getElementById(`doc-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <>
      <input
        className="set-docs-search"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search these docs"
        aria-label="Search these docs"
      />
      {toc.length === 0 ? (
        <div className="set-docs-empty">Nothing found for &ldquo;{query.trim()}&rdquo;.</div>
      ) : (
        <div className="set-docs">
          <nav className="set-docs-toc" aria-label="Sections">
            {toc.map((t) => (
              <button key={t.id} type="button" className={t.id === active ? "active" : undefined} onClick={() => jump(t.id)}>
                {t.title}
              </button>
            ))}
          </nav>
          <div ref={mainRef} className="set-docs-main">
            {sections.map((d) => (
              <div key={d.id} id={`doc-${d.id}`} data-doc={d.id} className="set-docs-anchor">
                <SettingsSection num={two(MAIN.indexOf(d) + 1)} title={d.title} description={d.summary}>
                  {d.body.map((p, i) => <p key={i} className="set-docs-p">{linkTabs(p, onGoToTab)}</p>)}
                </SettingsSection>
              </div>
            ))}
            {faq.length > 0 && (
              <div id="doc-faq" data-doc="faq" className="set-docs-anchor">
                <SettingsSection num={two(MAIN.length + 1)} title="Questions" description="Short answers to what people ask most.">
                  {faq.map((f) => (
                    <details key={f.q} className="set-docs-faq">
                      <summary>{f.q}</summary>
                      <p>{linkTabs(f.a, onGoToTab)}</p>
                    </details>
                  ))}
                </SettingsSection>
              </div>
            )}
            {help && (
              <div id={`doc-${help.id}`} data-doc={help.id} className="set-docs-anchor">
                <p className="set-docs-foot"><strong>{help.title}.</strong> {linkTabs(help.body.join(" "), onGoToTab)}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
