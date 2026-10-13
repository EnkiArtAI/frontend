import React from "react";
import { ChevronLeft } from "lucide-react";
import "./settings.css";

interface SettingsLayoutProps {
  children: React.ReactNode;
  breadcrumbs: string;
  title: React.ReactNode;
  description?: string;
  /** Back to where Settings was opened from; the button stays at the top left while the page scrolls (Kev, 2026-10-13). */
  onBack: () => void;
}

export default function SettingsLayout({ children, breadcrumbs, title, description, onBack }: SettingsLayoutProps) {
  return (
    <div className="set-page">
      <div className="set-container">
        <button type="button" className="set-back" onClick={onBack}>
          <ChevronLeft size={13} strokeWidth={2.4} aria-hidden />Back
        </button>
        <div className="set-breadcrumbs">{breadcrumbs}</div>
        <h1 className="set-title">{title}</h1>
        {/* Always rendered so the reserved min-height keeps the tab menu fixed. */}
        <p className="set-description">{description}</p>
        {children}
      </div>
    </div>
  );
}
