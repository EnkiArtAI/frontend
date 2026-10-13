"use client";

import { useCallback, useState } from "react";
import NftPickerModal from "@/components/enki/NftPickerModal";
import BoostToggle from "@/components/generation/BoostToggle";
import AddFundsPopover from "@/components/kit/AddFundsPopover";
import CostLine from "@/components/kit/CostLine";
import FullscreenViewer from "@/components/kit/FullscreenViewer";
import GenerateButton from "@/components/kit/GenerateButton";
import GeneratorPill from "@/components/kit/GeneratorPill";
import ReferenceTiles from "@/components/kit/ReferenceTiles";
import { QualityPill, RatioPill, ResolutionPill } from "@/components/kit/SettingsPills";
import { openAddFunds } from "@/lib/ui/kit/controls";
import { clampIndex } from "@/lib/ui/kit/viewer";
import AgentRow from "./AgentRow";
import ComposerHeader from "./ComposerHeader";
import Discussion from "./Discussion";
import HistoryRail from "./HistoryRail";
import MainImage from "./MainImage";
import PreviewStrip from "./PreviewStrip";
import PromptPanel from "./PromptPanel";
import ViewerPanel from "./ViewerPanel";
import type { ImageViewModel, Shot } from "./useImageViewModel";

type Tier = "wide" | "medium" | "stacked";

/**
 * The tier (spec §3.5): the viewport sets it (≥ 1280 wide, 1024–1279 medium,
 * below stacked) and the frame's own width can only lower it, because the
 * view sits beside the shell's menu.
 */
const tierOf = (viewport: number, frame: number): Tier =>
  viewport < 1024 || frame < 760 ? "stacked" : viewport < 1280 || frame < 1000 ? "medium" : "wide";

/** What the reference row says about its cap. */
function refHint(m: ImageViewModel): string {
  const name = m.core.entry?.name;
  if (!name) return "Pick a generator to add images";
  if (!m.cap) return `${name} takes no reference images`;
  const over = m.over ? ` · ${m.over} not sent with ${name}` : "";
  return `${m.premium ? `Add up to ${m.cap} images of yours` : `Optional · up to ${m.cap} image${m.cap === 1 ? "" : "s"}`}${over}`;
}

/**
 * The Image View from 768 px up (handoff §2): the composer on the left, the
 * stage, its strip and the discussion in the centre, the history on the
 * right, each scrolling on its own (wide, medium); one column with the
 * history as a drawer below 1024 px (stacked).
 */
export default function ImageViewDesktop({ model: m, onClose }: { model: ImageViewModel; onClose: () => void }) {
  const [tier, setTier] = useState<Tier | null>(null);
  // Measured as the root attaches, so the first paint already has its tier.
  const root = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const fit = () => setTier(tierOf(window.innerWidth, el.clientWidth));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [railPick, setRail] = useState<boolean | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [viewer, setViewer] = useState<{ keys: string[]; at: number } | null>(null);
  const [nft, setNft] = useState(false);

  // Open on the wide tier, folded below it, until the reader says otherwise.
  const rail = railPick ?? tier === "wide";
  const byKey = new Map(m.finished.map((x) => [x.key, x]));
  const items = viewer ? viewer.keys.flatMap((k) => byKey.get(k) ?? []) : [];
  const at = viewer ? clampIndex(viewer.at, items.length) : 0;
  const open = (s: Shot) => {
    const keys = m.finished.map((x) => x.key);
    if (!keys.includes(s.key)) return;
    m.seen(s);
    setViewer({ keys, at: keys.indexOf(s.key) });
  };

  const header = <ComposerHeader model={m} onBack={onClose} />;
  const compose = (
    <>
      <PromptPanel model={m} />
      {!m.guest && (
        <ReferenceTiles items={m.refs.map((r, i) => ({ ...r, over: i >= m.cap }))} pending={m.pending} cap={m.cap}
          accept={m.accept} size={56} hint={refHint(m)} onAddFiles={m.addFiles} onRemove={m.removeRef} onReorder={m.moveRef}
          nft={m.cap > 0 ? { as: "link", onOpen: () => setNft(true) } : undefined} />
      )}
    </>
  );
  const foot = (
    <div className="iv-foot">
      {!m.blank && !m.guest && <AgentRow model={m} />}
      <div className="iv-bar">
        <GeneratorPill models={m.models} value={m.core.entry?.id ?? null} onChange={m.pickModel} prices={m.modelPrices}
          look="logo" direction="up" />
        {!m.guest && (
          <>
            <RatioPill core={m.core} value={m.ratio} onChange={m.setRatio} />
            <ResolutionPill core={m.core} value={m.resolution} onChange={m.setResolution} prices={m.tierPrices} />
            {m.core.supportsQuality && <QualityPill value={m.quality} onChange={m.setQuality} prices={m.qualityPrices} />}
            <BoostToggle label boost={m.boost} onChange={m.setBoost} available={m.core.boostAvailable}
              sameHost={!m.core.boostAt(m.resolution)} />
          </>
        )}
      </div>
      <div className="iv-gen">
        {m.funds && (
          <AddFundsPopover balanceUsd={m.funds.balanceUsd} totalUsd={m.funds.totalUsd} onAddFunds={openAddFunds}
            onTryAnyway={m.tryAnyway} onClose={m.closeFunds} />
        )}
        <GenerateButton label={m.button.label} chip={m.chip} chipPending={m.quotePending} dimmed={m.button.dimmed}
          short={m.short} onPress={m.generate} size="block" />
      </div>
      <CostLine left={m.cost} />
    </div>
  );
  const stage = (
    <>
      <MainImage model={m} onOpen={open} onClose={onClose} />
      <PreviewStrip model={m} />
    </>
  );
  const talk = !m.blank && <Discussion model={m} />;

  return (
    <div ref={root} className="iv-root kit-focus" data-tier={tier ?? undefined} data-rail={!m.blank && !m.guest || undefined}>
      {tier === "stacked" ? (
        <div className="iv-stack">
          {header}
          <div className="iv-stack-stage">{stage}</div>
          <div className="iv-stack-body">{compose}</div>
          {foot}
          {talk && <div className="iv-stack-talk">{talk}</div>}
        </div>
      ) : tier && (
        <>
          <aside className="iv-left">
            {header}
            <div className="iv-left-scroll">{compose}</div>
            {foot}
          </aside>
          <section className="iv-center">{stage}{talk}</section>
        </>
      )}
      {tier && !m.blank && !m.guest && (
        <HistoryRail model={m} drawer={tier === "stacked"} open={tier === "stacked" ? drawer : rail}
          onToggle={tier === "stacked" ? () => setDrawer(!drawer) : () => setRail(!rail)} />
      )}
      {viewer && items[at] && (
        <FullscreenViewer items={items.map((x) => ({ key: x.key, src: x.src, ratio: x.ratio }))} index={at}
          onIndex={(i) => {
            m.seen(items[i]);
            setViewer({ ...viewer, at: i });
          }}
          onClose={(last) => {
            setViewer(null);
            m.select(items[last]);
          }}
          layout={tier === "stacked" ? "stacked" : "side"} nav={tier === "stacked" ? "dots" : "thumbs"}
          panel={
            <ViewerPanel model={m} shot={items[at]} n={m.finished.indexOf(items[at]) + 1} onAgain={() => setViewer(null)} />
          } />
      )}
      {nft && <NftPickerModal max={m.room} onPick={m.addNfts} onClose={() => setNft(false)} />}
    </div>
  );
}
