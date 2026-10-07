"use client";

// Force dynamic rendering to prevent static generation issues
export const dynamic = 'force-dynamic';

import "./enki-editor.css";
import EnkiPromptEditor from "@/components/EnkiPromptEditor";

export default function Editor() {
  return (
    // Below the 2FA bar when it shows (--ek-banner-h).
    <div style={{ position: "fixed", inset: "var(--ek-banner-h, 0px) 0 0 0", zIndex: 100 }}>
      <EnkiPromptEditor />
    </div>
  );
}
