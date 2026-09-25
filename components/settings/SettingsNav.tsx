import React, { useEffect, useRef } from "react";
import "./settings.css";

export interface TabItem {
  id: string;
  label: string;
  disabled?: boolean;
  crossed?: boolean;
  tooltip?: string;
}

interface SettingsNavProps {
  tabs: TabItem[];
  activeTab: string;
  onChange: (id: string) => void;
}

export default function SettingsNav({ tabs, activeTab, onChange }: SettingsNavProps) {
  const ref = useRef<HTMLDivElement>(null);
  // The strip scrolls horizontally on phones and hides its scrollbar, so a
  // deep link or tab change must bring the active tab into view itself.
  useEffect(() => {
    ref.current?.querySelector(".set-nav-item.active")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTab]);

  return (
    <div className="set-nav" ref={ref}>
      {tabs.map(tab => {
        let classes = "set-nav-item";
        if (tab.id === activeTab) classes += " active";
        if (tab.disabled) classes += " disabled";
        if (tab.crossed) classes += " crossed disabled";

        return (
          <button
            key={tab.id}
            className={classes}
            onClick={() => {
              if (!tab.disabled && !tab.crossed) {
                onChange(tab.id);
              }
            }}
            title={tab.tooltip}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
