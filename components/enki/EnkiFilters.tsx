"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LayoutGrid, Search, X, Cpu } from "lucide-react";
import GeneratorLogo from "@/components/generation/GeneratorLogo";
import "@/components/generation/ratio-select.css";
import { openCreator } from "@/lib/openCreator";
import { SUGGEST_DEBOUNCE_MS, flattenSuggestions, stepActive, type SuggestItem } from "@/lib/search/client";
import { viewerHeaders } from "@/lib/session-headers";

/**
 * Canonical category list — shared between the feed filter bar and the
 * prompt editor's category dropdown so both always offer the same set.
 * Add/rename categories here only.
 */
import { ENKI_CATEGORIES } from "@/lib/categories";
export { ENKI_CATEGORIES };

const CATEGORIES = ENKI_CATEGORIES.map((label) => ({ label }));

type EnkiFiltersProps = {
  active: string[];
  toggle: (tag: string) => void;
  /** When true, only one category can be active at a time (radio behavior) */
  exclusive?: boolean;
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

export default function EnkiFilters({ active, toggle, generators, generatorFilter, onGeneratorFilter, showAdult, onShowAdult }: EnkiFiltersProps) {
  const allActive = active.length === 0;
  const [visible, setVisible] = useState(true);
  /* Lifted out of SearchChip: while the search is open it OWNS the row —
     the categories fade back and the field spreads over them (Kev,
     2026-08-24: "predominant temporarily aufgeklappt über den rubriken"). */
  const [searchOpen, setSearchOpen] = useState(false);
  const lastScrollY = useRef(0);
  const ticking = useRef(false);

  useEffect(() => {
    const handleScroll = () => {
      if (!ticking.current) {
        window.requestAnimationFrame(() => {
          const currentY = window.scrollY;
          if (currentY < 80) setVisible(true);
          else if (currentY < lastScrollY.current - 4) setVisible(true);
          else if (currentY > lastScrollY.current + 4) setVisible(false);
          lastScrollY.current = currentY;
          ticking.current = false;
        });
        ticking.current = true;
      }
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div className={`enki-catbar enki-catbar--tworow${visible ? "" : " enki-catbar--hidden"}${searchOpen ? " enki-catbar--searching" : ""}`}>
      {/* Row 1: categories + search. The open search spreads over the
          chips; the FILTER row below stays put, so search + filters work
          together (Kev, 2026-08-24). */}
      <div className="enki-catbar-row">
        <button
          className={`enki-catbar-all${allActive ? " active" : ""}`}
          onClick={() => active.forEach((tag) => toggle(tag))}
          type="button"
          aria-label="All categories"
          tabIndex={searchOpen ? -1 : 0}
        >
          <LayoutGrid size={14} />
          All
        </button>

        <div className="enki-catbar-divider" />

        {/* All categories, inline in a single row */}
        <div className="enki-catbar-scroll">
          {CATEGORIES.map((cat) => {
            const key = cat.label.toLowerCase();
            const isActive = active.includes(key);
            return (
              <button
                key={key}
                className={`enki-catbar-chip${isActive ? " active" : ""}`}
                onClick={() => toggle(key)}
                type="button"
                tabIndex={searchOpen ? -1 : 0}
              >
                {cat.label}
              </button>
            );
          })}
        </div>

        <SearchChip open={searchOpen} setOpen={setSearchOpen} />
      </div>

      {/* Row 2: the filters, DIRECTLY under the category row (Kev,
          2026-08-24), right-aligned so they sit beside an open search. Part
          of the fixed bar — page scrolling can neither move nor close them.
          No chip until the catalogue answered: an empty tree pretends the
          platform has no models. */}
      {((generators && generators.length > 0 && onGeneratorFilter) || onShowAdult) && (
        <div className="enki-filterrow">
          {generators && generators.length > 0 && onGeneratorFilter && (
            <GeneratorInline groups={generators} selected={generatorFilter ?? []} onChange={onGeneratorFilter} />
          )}
          {onShowAdult && (
            <span className="enki-fltr-group">
              <button type="button" aria-pressed={showAdult === true}
                className={"enki-fltr-chip" + (showAdult ? " active" : "")}
                title={showAdult ? "Hide 18+ prompts" : "Show 18+ prompts"}
                onClick={() => onShowAdult(!showAdult)}>
                18+
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Generator filter, laid out FLAT along the filter row (Kev, 2026-08-24:
 * "pack alle möglichkeiten längs auf das menü") — every option is one click
 * away, no dropdown between you and it. Group labels (IMAGE / VIDEO) toggle
 * their whole group; each generator chip toggles alone. MULTIPLE CHOICE
 * throughout, "All" resets. Lives in the fixed bar, so scrolling the page
 * cannot move it and nothing here ever scrolls.
 */
function GeneratorInline({ groups, selected, onChange }: {
  groups: GeneratorGroup[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const flip = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const flipGroup = (g: GeneratorGroup) => {
    const ids = g.entries.map((e) => e.id);
    const all = ids.every((id) => selected.includes(id));
    onChange(all ? selected.filter((x) => !ids.includes(x)) : [...new Set([...selected, ...ids])]);
  };

  return (
    <>
      {/* The icon IS the reset (Kev, 2026-08-24): it sat there without a
          job, and the "All" chip on the far right doubled the row's width
          promise for a one-tap action. Ember while a filter is active, so
          it reads as pressable exactly when pressing it does something. */}
      <button type="button" className={"enki-fltr-icon" + (selected.length ? " active" : "")}
        title={selected.length ? "Reset generator filter" : "Generator filter"}
        aria-label="Reset generator filter" disabled={!selected.length}
        onClick={() => onChange([])}>
        <Cpu size={13} />
      </button>
      {groups.map((g) => {
        const ids = g.entries.map((e) => e.id);
        const all = ids.length > 0 && ids.every((id) => selected.includes(id));
        return (
          /* Each medium sits in its own SUPER-SOFT outline (Kev,
             2026-08-24) — the frame does the grouping, no divider needed. */
          <span key={g.label} className="enki-fltr-group">
            <button type="button" className={"enki-fltr-glabel" + (all ? " active" : "")}
              title={all ? `Deselect all ${g.label} generators` : `Select all ${g.label} generators`}
              onClick={() => flipGroup(g)}>
              {g.label}
            </button>
            {/* Selection is COLOR ONLY — a checkmark grew the chip and
                shoved its neighbours (Kev, 2026-08-24). */}
            {g.entries.map((e) => (
              <button key={e.id} type="button" aria-pressed={selected.includes(e.id)}
                className={"enki-fltr-chip" + (selected.includes(e.id) ? " active" : "")}
                onClick={() => flip(e.id)}>
                <GeneratorLogo name={e.name} size={13} />
                {e.name}
              </button>
            ))}
          </span>
        );
      })}
    </>
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
    <div className={`enki-catbar-search${open ? " open" : ""}`}>
      <button
        type="button"
        className="enki-catbar-searchbtn"
        aria-label={open ? "Close search" : "Search prompts"}
        aria-expanded={open}
        title="Search prompts (Ctrl K)"
        onClick={() => {
          if (open && query) push("");
          setOpen((v) => !v);
          if (!open) requestAnimationFrame(() => inputRef.current?.focus());
        }}
      >
        {open ? <X size={14} /> : <Search size={14} />}
      </button>
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
            if (listShown) { setDismissed(true); return; }
            if (query) push("");
            setOpen(false);
          }
        }}
      />
      {listShown && (
        <ul className="enki-search-suggest" id="enki-search-suggest" role="listbox">
          {items.map((item, i) => (
            <li
              key={`${item.kind}-${item.id}`}
              id={`enki-suggest-${i}`}
              role="option"
              aria-selected={i === active}
              className={`enki-search-suggest-item${i === active ? " active" : ""}`}
              /* mousedown, not click: the input's blur would hide the list
                 before a click could land. */
              onMouseDown={(e) => { e.preventDefault(); choose(item); }}
              onMouseEnter={() => setActive(i)}
            >
              {item.kind === "creator" && <span className="enki-search-suggest-kind">Creator</span>}
              <span className="enki-search-suggest-label">{item.label}</span>
              {item.kind === "creator" && <small>@{item.handle}</small>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
