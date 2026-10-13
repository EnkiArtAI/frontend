"use client";

import type { CSSProperties } from "react";
import FullscreenViewer from "@/components/kit/FullscreenViewer";
import JobTile from "@/components/kit/JobTile";
import ValueList from "@/components/kit/ValueList";
import { varNames } from "@/lib/editor/prompt-tokens";
import { previewList, siblingTag, type Stars, type Variation } from "@/lib/editor/variations";
import type { EditorJob } from "./ResultTile";

const QUALITY: Record<string, string> = { low: "Low", medium: "Mid", high: "High" };

/**
 * A render full screen. A finished one pages through every finished render,
 * newest variation first, beside the values it was made with, "← Use these
 * values", the star and Regenerate. A failed one shows its setup with Retry
 * and Remove. Regenerate and Retry run the job exactly as it was made (D7)
 * and show the price that charges. Below 1024 px the variation's siblings
 * sit under the values, each tagged with what differs (handoff §5).
 */
export default function RenderPreview({ job, groups, stars, price, stacked, onShow, onClose, onUse, onStar, onRun, onRemove }: {
  job: EditorJob;
  groups: Variation[];
  stars: Stars;
  /** What Regenerate or Retry charges: "$0.147", "$0.00", "…" while it is asked. */
  price: string;
  stacked: boolean;
  onShow: (id: string) => void;
  onClose: () => void;
  onUse: (job: EditorJob) => void;
  onStar: (id: string) => void;
  /** Runs the job again; `retry` takes the failed one's place. */
  onRun: (job: EditorJob, retry: boolean) => void;
  onRemove: (id: string) => void;
}) {
  const failed = job.status === "failed";
  const list = failed ? [job] : previewList(groups);
  const at = Math.max(0, list.findIndex((j) => j.id === job.id));
  const group = groups.find((g) => g.jobs.some((j) => j.id === job.id));
  const siblings = failed ? [] : group?.jobs.filter((j) => j.status === "ready") ?? [];
  const s = job.setup;
  const names = varNames(s.prompt);
  const rows = names.length
    ? names.map((n) => ({ name: n || "unnamed", value: s.vars[n] ?? "", checked: s.kinds[n] === "checkbox" ? true : undefined }))
    : [{ name: "prompt", value: s.prompt }];
  const on = stars[job.id] !== undefined;
  return (
    <FullscreenViewer
      items={list.map((j) => ({
        key: j.id,
        src: j.imageUrl,
        ratio: j.setup.ratio,
        failed: j.status === "failed" ? { message: j.error?.message ?? "Render failed · not charged" } : undefined,
      }))}
      index={at}
      onIndex={(i) => onShow(list[i].id)}
      onClose={onClose}
      layout={stacked ? "stacked" : "side"}
      nav={stacked ? "dots" : "thumbs"}
      top={group && (
        <span className="pe-pv-chip" style={{ "--pe-vc": group.color } as CSSProperties}>
          Variation {group.letter}{failed ? " · failed" : ` · ${at + 1} / ${list.length}`}
        </span>
      )}
      panel={
        <div className="pe-pv">
          <p className="pe-pv-meta">
            {s.resolution} · {s.modelName} · {s.ratio}{s.quality ? ` · ${QUALITY[s.quality]}` : ""}{s.boost ? " · Boost" : ""}
          </p>
          <ValueList rows={rows} tone="stage" />
          {siblings.length > 1 && (
            <div className="pe-sibs pe-tabs-only">
              <span className="pe-sibs-label">This variation · {siblings.length} images</span>
              <div className="pe-sibs-strip kit-noscroll">
                {siblings.map((j) => {
                  const tag = siblingTag(s, j.setup);
                  return (
                    <JobTile key={j.id} status="ready" src={j.imageUrl} ratio={j.setup.ratio} height={64} seen={j.seen}
                      selected={j.id === job.id} star={stars[j.id] !== undefined ? { on: true } : undefined}
                      label={tag ? `Different ${tag.slice(2)}` : "Same values"} onClick={() => onShow(j.id)}>
                      {tag && <span className="pe-sib-tag">{tag}</span>}
                    </JobTile>
                  );
                })}
              </div>
            </div>
          )}
          <div className="pe-pv-acts">
            <button type="button" className="pe-pv-use" onClick={() => onUse(job)}>← Use these values in the editor</button>
            {failed ? (
              <>
                <button type="button" className="pe-pv-btn" onClick={() => onRun(job, true)}>⟳ Retry · {price}</button>
                <button type="button" className="pe-pv-btn" onClick={() => onRemove(job.id)}>Remove</button>
              </>
            ) : (
              <>
                <button type="button" className="pe-pv-btn" aria-pressed={on} onClick={() => onStar(job.id)}>
                  {on ? "★ Starred" : "☆ Star for release"}
                </button>
                <button type="button" className="pe-pv-btn" onClick={() => onRun(job, false)}>⟳ Regenerate · {price}</button>
              </>
            )}
          </div>
        </div>
      }
    />
  );
}
