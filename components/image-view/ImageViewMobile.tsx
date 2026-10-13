"use client";

import { useId, useState } from "react";
import NftPickerModal from "@/components/enki/NftPickerModal";
import BoostToggle from "@/components/generation/BoostToggle";
import AddFundsPopover from "@/components/kit/AddFundsPopover";
import CostLine from "@/components/kit/CostLine";
import FullscreenViewer from "@/components/kit/FullscreenViewer";
import GenerateButton from "@/components/kit/GenerateButton";
import GeneratorPill from "@/components/kit/GeneratorPill";
import JobTile from "@/components/kit/JobTile";
import ReferenceTiles from "@/components/kit/ReferenceTiles";
import { QualityPill, RatioPill, ResolutionPill } from "@/components/kit/SettingsPills";
import { openAddFunds } from "@/lib/ui/kit/controls";
import { formatAgo } from "@/lib/ui/kit/format";
import { clampIndex } from "@/lib/ui/kit/viewer";
import { jobSaid } from "@/lib/ui/image-view/setups";
import { countLabel } from "@/lib/ui/image-view/discussion";
import AgentRow from "./AgentRow";
import ComposerHeader from "./ComposerHeader";
import Discussion from "./Discussion";
import MainImage from "./MainImage";
import PublicMark from "./PublicMark";
import PromptPanel from "./PromptPanel";
import ViewerPanel from "./ViewerPanel";
import type { ImageViewModel, Shot } from "./useImageViewModel";
import "./image-view-mobile.css";

type Tab = "generate" | "history" | "comments";

/** The phone layout shares the desktop model; only the arrangement changes. */
export default function ImageViewMobile({ model: m, onClose }: { model: ImageViewModel; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("generate");
  const [viewer, setViewer] = useState<{ keys: string[]; at: number } | null>(null);
  const [nft, setNft] = useState(false);
  const uid = useId();
  const tabs: Tab[] = m.blank ? ["generate"] : m.guest ? ["generate", "comments"] : ["generate", "history", "comments"];
  const active = tabs.includes(tab) ? tab : "generate";
  const labels: Record<Tab, string> = {
    generate: "Generate", history: `History · ${m.history.length}`,
    comments: `Comments${m.discussion.data ? ` · ${countLabel(m.discussion.data.comments.length, m.discussion.data.capped)}` : ""}`,
  };
  // Failed jobs can be inspected and retried too. Rendering jobs stay on the stage.
  const shots = [...new Map([...m.queue.filter((s) => s.job?.status !== "rendering"), ...m.finished].map((s) => [s.key, s])).values()];
  const byKey = new Map(shots.map((s) => [s.key, s]));
  const items = viewer ? viewer.keys.flatMap((key) => byKey.get(key) ?? []) : [];
  const at = viewer ? clampIndex(viewer.at, items.length) : 0;
  const open = (shot: Shot) => {
    if (shot.job?.status === "rendering") { m.select(shot); return; }
    const keys = shots.map((s) => s.key);
    if (!keys.includes(shot.key)) return;
    m.seen(shot);
    setViewer({ keys, at: keys.indexOf(shot.key) });
  };
  const history = m.historyState;
  const previews = [...m.examples, ...m.community];
  const hint = !m.core.entry ? "Pick a generator to add images"
    : !m.cap ? `${m.core.entry.name} takes no reference images`
    : `Optional · up to ${m.cap} image${m.cap === 1 ? "" : "s"}${m.over ? ` · ${m.over} not sent with ${m.core.entry.name}` : ""}`;

  return (
    <div className="iv-root iv-mobile kit-focus" data-tier="phone">
      <ComposerHeader model={m} onBack={onClose} />
      <div className="iv-mobile-stage">
        {m.examples.length > 1 && (!m.main || m.main.kind === "example") ? (
          <div className="iv-mobile-examples" aria-label="Creator examples">
            {m.examples.slice(0, 4).map((s, i) => (
              <button key={s.key} type="button" aria-label={`Open creator example ${i + 1}`} onClick={() => open(s)}>
                <img src={s.src} alt="" decoding="async" draggable={false} />
              </button>
            ))}
          </div>
        ) : <MainImage model={m} onOpen={open} onClose={onClose} />}
      </div>
      {!!previews.length && (
        <div className="iv-mobile-previews kit-noscroll" aria-label="Image previews">
          {previews.map((s, i) => (
            <button key={s.key} type="button" className="iv-thumb" aria-pressed={m.main?.key === s.key}
              aria-label={s.kind === "example" ? `Creator example ${i + 1}` : `Made with this prompt ${i - m.examples.length + 1}`}
              onClick={() => { m.select(s); }}>
              <img src={s.thumb} alt="" loading="lazy" draggable={false} />
            </button>
          ))}
        </div>
      )}
      <div className="iv-mobile-tabs" role="tablist" aria-label="Image view">
        {tabs.map((t, i) => (
          <button key={t} type="button" role="tab" id={`${uid}-${t}`} aria-controls={`${uid}-panel`}
            aria-selected={active === t} tabIndex={active === t ? 0 : -1} onClick={() => setTab(t)}
            onKeyDown={(e) => {
              const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i + tabs.length - 1) % tabs.length
                : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
              if (next === null) return;
              e.preventDefault(); setTab(tabs[next]);
              document.getElementById(`${uid}-${tabs[next]}`)?.focus();
            }}>{labels[t]}</button>
        ))}
      </div>
      <section id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-${active}`} className="iv-mobile-panel">
        <div hidden={active !== "generate"}>
          <div className="iv-mobile-compose">
            <PromptPanel model={m} />
            {!m.guest && <ReferenceTiles items={m.refs.map((r, i) => ({ ...r, over: i >= m.cap }))} pending={m.pending}
              cap={m.cap} accept={m.accept} size={56} hint={hint} onAddFiles={m.addFiles} onRemove={m.removeRef} onReorder={m.moveRef}
              nft={m.cap > 0 ? { as: "link", onOpen: () => setNft(true) } : undefined} />}
          </div>
          <div className="iv-foot">
            {!m.blank && !m.guest && <AgentRow model={m} />}
            <div className="iv-bar">
              <GeneratorPill models={m.models} value={m.core.entry?.id ?? null} onChange={m.pickModel} prices={m.modelPrices} look="logo" direction="up" />
              {!m.guest && <>
                <RatioPill core={m.core} value={m.ratio} onChange={m.setRatio} />
                <ResolutionPill core={m.core} value={m.resolution} onChange={m.setResolution} prices={m.tierPrices} />
                {m.core.supportsQuality && <QualityPill value={m.quality} onChange={m.setQuality} prices={m.qualityPrices} />}
                <BoostToggle label boost={m.boost} onChange={m.setBoost} available={m.core.boostAvailable} sameHost={!m.core.boostAt(m.resolution)} />
              </>}
            </div>
            <div className="iv-gen">
              {m.funds && <AddFundsPopover balanceUsd={m.funds.balanceUsd} totalUsd={m.funds.totalUsd} onAddFunds={openAddFunds}
                onTryAnyway={m.tryAnyway} onClose={m.closeFunds} />}
              <GenerateButton label={m.button.label} chip={m.chip} chipPending={m.quotePending} dimmed={m.button.dimmed} short={m.short} onPress={m.generate} size="block" />
            </div>
            <CostLine left={m.cost} />
          </div>
        </div>
        {active === "history" && <div className="iv-mobile-history">
          {m.history.map((s) => (
            <div key={s.key} className="iv-mobile-hitem">
              <button type="button" className="iv-mobile-hpick" aria-pressed={m.main?.key === s.key}
                onClick={() => { m.select(s); setTab("generate"); }}>
                <img src={s.thumb} alt="" loading="lazy" draggable={false} /><span>{formatAgo(s.createdAt ?? "", m.now)}</span>
              </button>
              {s.record && <PublicMark record={s.record} onSet={m.setPublic} />}
            </div>
          ))}
          {history.loading ? <p className="iv-rail-note">Loading…</p> : history.failed
            ? <p className="iv-rail-note">Your renders could not load. <button type="button" className="iv-link" onClick={history.retry}>Try again</button></p>
            : !m.history.length && <p className="iv-rail-note">No renders of this prompt yet</p>}
          {history.more && <button type="button" className="iv-older kit-hit" disabled={history.loadingOlder} onClick={history.loadOlder}>
            {history.loadingOlder ? "Loading…" : "Load older"}</button>}
        </div>}
        {!m.blank && <div hidden={active !== "comments"}><Discussion model={m} /></div>}
      </section>
      {!!m.queue.length && <section className="iv-mobile-queue" aria-label="Render queue">
        <h2 className="iv-label">Queue · Tap to view</h2>
        <div className="iv-mobile-jobs">
          {m.queue.map((s) => s.job && <JobTile key={s.key} status={s.job.status} sent={s.job.sent} src={s.src} ratio={s.ratio} height={64}
            seen={s.job.seen} selected={m.main?.key === s.key} label={`Your render, ${jobSaid(s.job)}`} onClick={() => open(s)} onCancel={() => m.cancel(s)} />)}
        </div>
      </section>}
      {viewer && items[at] && <FullscreenViewer items={items.map((s) => ({ key: s.key, src: s.src, ratio: s.ratio,
        failed: s.job?.status === "failed" ? { message: "This image could not be generated. You can retry it." } : undefined }))}
        index={at} layout="stacked" nav="dots" onIndex={(i) => { m.seen(items[i]); setViewer({ ...viewer, at: i }); }}
        onClose={(last) => { setViewer(null); m.select(items[last]); }}
        panel={<ViewerPanel model={m} shot={items[at]} n={at + 1} onAgain={() => setViewer(null)} />} />}
      {nft && <NftPickerModal max={m.room} onPick={m.addNfts} onClose={() => setNft(false)} />}
    </div>
  );
}
