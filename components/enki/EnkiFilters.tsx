"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X, Cpu } from "lucide-react";
import GeneratorLogo from "@/components/generation/GeneratorLogo";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { openCreator } from "@/lib/openCreator";
import { TABS } from "@/lib/ui/kit/breakpoints";
import { SUGGEST_DEBOUNCE_MS, flattenSuggestions, stepActive, type SuggestItem } from "@/lib/search/client";
import { viewerHeaders } from "@/lib/session-headers";

/**
 * Canonical category list — shared between the feed filter bar and the
 * prompt editor's category dropdown so both always offer the same set.
 * Add/rename categories here only.
 */
import { ENKI_CATEGORIES } from "@/lib/categories";
export { ENKI_CATEGORIES };

type EnkiFiltersProps = {
  active: string[];
  /** A category key, or null for All. The active chip does not toggle off. */
  onPick: (key: string | null) => void;
  /** Generator filter — the catalogue grouped by media type. */
  generators?: GeneratorGroup[];
  /** Selected generator ids; empty = all. */
  generatorFilter?: string[];
  onGeneratorFilter?: (ids: string[]) => void;
  /** 18+ pill; rendered only when given, i.e. for a confirmed adult. */
  showAdult?: boolean;
  onShowAdult?: (on: boolean) => void;
};

export type GeneratorGroup = {
  /** "Image" | "Video" — subgroups arrive with the models that carry them. */
  label: string;
  entries: Array<{ id: string; name: string }>;
};

/**
 * The feed's one 44 px bar: the categories, then the Generator and 18+
 * chips and the search. Always on screen (handoff: sticky). Below 1024 px an
 * open search owns the row and the chips step back (Kev, 2026-08-24).
 */
export default function EnkiFilters({ active, onPick, generators, generatorFilter, onGeneratorFilter, showAdult, onShowAdult }: EnkiFiltersProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const takeover = useMediaQuery(TABS) && searchOpen;
  const chip = (key: string | null, label: string) => {
    const on = key === null ? active.length === 0 : active.includes(key);
    return (
      <button key={label} type="button" className="feed-chip kit-hit" aria-pressed={on} tabIndex={takeover ? -1 : 0}
        onClick={(e) => {
          if (on) return;
          onPick(key);
          e.currentTarget.scrollIntoView({ inline: "nearest", block: "nearest" });
        }}>
        {label}
      </button>
    );
  };

  return (
    <div className={"feed-bar" + (takeover ? " feed-bar--takeover" : "")}>
      <div className="feed-chips kit-noscroll" role="group" aria-label="Categories">
        {chip(null, "All")}
        {ENKI_CATEGORIES.map((label) => chip(label.toLowerCase(), label))}
      </div>
      <div className="feed-tools">
        {/* No chip until the catalogue answered: an empty tree pretends the
            platform has no models. */}
        {generators && generators.length > 0 && onGeneratorFilter && (
          <GeneratorChip groups={generators} selected={generatorFilter ?? []} onChange={onGeneratorFilter} />
        )}
        {onShowAdult && (
          <span className="enki-fltr-group">
            <button type="button" aria-pressed={showAdult === true}
              className={"feed-pill kit-hit" + (showAdult ? " on" : "")}
              title={showAdult ? "Hide 18+ prompts" : "Show 18+ prompts"}
              onClick={() => onShowAdult(!showAdult)}>
              18+
            </button>
          </span>
        )}
        <SearchChip open={searchOpen} setOpen={setSearchOpen} />
      </div>
    </div>
  );
}

/**
 * The generator filter behind one chip. Group labels (IMAGE / VIDEO) toggle
 * their whole group; each generator chip toggles alone; multiple choice
 * throughout, and the Cpu button resets.
 */
function GeneratorChip({ groups, selected, onChange }: {
  groups: GeneratorGroup[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey, true); };
  }, [open]);

  const flip = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const flipGroup = (g: GeneratorGroup) => {
    const ids = g.entries.map((e) => e.id);
    const all = ids.every((id) => selected.includes(id));
    onChange(all ? selected.filter((x) => !ids.includes(x)) : [...new Set([...selected, ...ids])]);
  };

  return (
    <span className="feed-gen" ref={wrapRef}>
      <button type="button" className={"feed-pill kit-hit" + (selected.length ? " on" : "")}
        aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Generator{selected.length > 0 && <span className="feed-pill-n"> · {selected.length}</span>}
      </button>
      {open && (
        <div className="feed-gen-pop" role="dialog" aria-label="Generator filter">
          <button type="button" className="feed-gen-reset" disabled={!selected.length} onClick={() => onChange([])}>
            <Cpu size={13} /> All generators
          </button>
          {groups.map((g) => {
            const ids = g.entries.map((e) => e.id);
            const all = ids.length > 0 && ids.every((id) => selected.includes(id));
            return (
              <div key={g.label} className="feed-gen-group">
                <button type="button" className={"feed-gen-label" + (all ? " on" : "")} aria-pressed={all}
                  title={all ? `Deselect all ${g.label} generators` : `Select all ${g.label} generators`}
                  onClick={() => flipGroup(g)}>
                  {g.label}
                </button>
                {g.entries.map((e) => (
                  <button key={e.id} type="button" aria-pressed={selected.includes(e.id)}
                    className={"feed-gen-chip" + (selected.includes(e.id) ? " on" : "")}
                    onClick={() => flip(e.id)}>
                    <GeneratorLogo name={e.name} size={13} />
                    {e.name}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}

function SearchChip({ open, setOpen }: { open: boolean; setOpen: (v: boolean | ((v: boolean) => boolean)) => void }) {
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = useState(params.get("q") || "");
  /* Open when it has something to show. A search that closed itself while a
     query was still filtering the feed would leave the user looking at a
     narrowed list with nothing on screen saying why. */
  useEffect(() => {
    if (params.get("q")) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const inputRef = useRef<HTMLInputElement>(null);

  /* Typeahead: titles and creators from /api/search/suggest, a debounce
     after each keystroke, the stale request aborted. Titles only, tags stay
     invisible (Kev). `dismissed` hides the list after Enter, Escape, a pick
     or blur until the next keystroke or focus; it starts hidden so a page
     loaded with ?q= shows no list until the user touches the field. */
  const [items, setItems] = useState<SuggestItem[]>([]);
  const [active, setActive] = useState(-1);
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    const q = query.trim();
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      if (!q) { setItems([]); setActive(-1); return; }
      fetch(`/api/search/suggest?q=${encodeURIComponent(q)}`, { headers: viewerHeaders(), credentials: "include", signal: ctrl.signal })
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => { setItems(body ? flattenSuggestions(body) : []); setActive(-1); })
        .catch(() => {});
    }, SUGGEST_DEBOUNCE_MS);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [query]);
  const listShown = open && !dismissed && query.trim() !== "" && items.length > 0;

  const push = (value: string) => {
    setQuery(value);
    setDismissed(false);
    const next = new URLSearchParams(Array.from(params.entries()));
    if (value) next.set("q", value);
    else next.delete("q");
    router.replace(`?${next.toString()}`, { scroll: false });
  };

  /* Two ways in, both ending here because the field lives here now.
     Ctrl/Cmd+K, and the sidebar's own Search item, which can no longer hold a
     ref to an input in another component and asks by event instead. Both OPEN
     it before focusing: focusing something that is not on screen does nothing
     a user can see. */
  useEffect(() => {
    const reveal = () => {
      setOpen(true);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        reveal();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("enki:open-search", reveal);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("enki:open-search", reveal);
    };
  }, []);

  /* push() shows the list again; the dismissal must come AFTER it, the
     last set in one event wins, or picking a title reopens the list. */
  const choose = (item: SuggestItem) => {
    if (item.kind === "title") push(item.label);
    else openCreator(item.handle, router);
    setDismissed(true);
  };

  return (
    <div className={`feed-search${open ? " open" : ""}`}>
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => push(e.target.value)}
        placeholder="Search prompts and artists"
        aria-label="Search prompts"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={listShown}
        aria-controls="enki-search-suggest"
        aria-activedescendant={listShown && active >= 0 ? `enki-suggest-${active}` : undefined}
        onFocus={() => setDismissed(false)}
        onBlur={() => setDismissed(true)}
        /* Hidden from tab order while closed: a field nobody can see must not
           be reachable by keyboard either, or focus vanishes off screen. */
        tabIndex={open ? 0 : -1}
        onKeyDown={(e) => {
          if (listShown && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setActive(stepActive(active, e.key === "ArrowDown" ? 1 : -1, items.length));
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (listShown && active >= 0) choose(items[active]);
            else setDismissed(true);
            return;
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            if (listShown) { setDismissed(true); return; }
            if (query) push("");
            setOpen(false);
          }
        }}
      />
      <button
        type="button"
        className="feed-search-btn kit-hit"
        aria-label={open ? "Close search" : "Search prompts"}
        aria-expanded={open}
        title="Search prompts (Ctrl K)"
        onClick={() => {
          if (open && query) push("");
          setOpen((v) => !v);
          if (!open) requestAnimationFrame(() => inputRef.current?.focus());
        }}
      >
        {open ? <X size={14} strokeWidth={2.2} /> : <Search size={14} strokeWidth={2.2} />}
      </button>
      {listShown && (
        <ul className="feed-suggest" id="enki-search-suggest" role="listbox">
          {items.map((item, i) => (
            <li
              key={`${item.kind}-${item.id}`}
              id={`enki-suggest-${i}`}
              role="option"
              aria-selected={i === active}
              className={`feed-suggest-item${i === active ? " active" : ""}`}
              /* mousedown, not click: the input's blur would hide the list
                 before a click could land. */
              onMouseDown={(e) => { e.preventDefault(); choose(item); }}
              onMouseEnter={() => setActive(i)}
            >
              {item.kind === "creator" && <span className="feed-suggest-kind">Creator</span>}
              <span className="feed-suggest-label">{item.label}</span>
              {item.kind === "creator" && <small>@{item.handle}</small>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
