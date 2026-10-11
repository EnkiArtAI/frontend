"use client";

// Force dynamic rendering to prevent static generation issues
export const dynamic = 'force-dynamic';

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import EnkiHome from "@/components/enki-shell/EnkiHome";
import PromptEditor from "@/components/prompt-editor/PromptEditor";
import { useViewerWallets } from "@/hooks/useViewerWallets";
import { useBetaAccess } from "@/components/BetaGate";
import { editorMount, type EditorMount } from "@/lib/editor/editor-mount";

/**
 * The Prompt Editor inside the shell (plan R1): the shell keeps its menu,
 * login, billing panel and 2FA bar, and the editor's fixed layer covers its
 * feed. Another ?id= or another account gets a fresh editor (editorMount).
 */
function EditorRoute() {
  const id = useSearchParams().get("id");
  const { userKey } = useViewerWallets();
  const { userId } = useBetaAccess();
  const owner = userKey ?? (userId ? "account:" + userId : null);
  const [mount, setMount] = useState<EditorMount>({ id, n: 0, own: null, user: owner });
  const next = editorMount(mount, id, owner);
  if (next !== mount) setMount(next);
  return (
    <EnkiHome>
      <PromptEditor key={mount.n} promptId={id ?? undefined} onReleased={(own) => setMount((m) => ({ ...m, own }))} />
    </EnkiHome>
  );
}

export default function Editor() {
  return (
    <Suspense fallback={null}>
      <EditorRoute />
    </Suspense>
  );
}
