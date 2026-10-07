"use client";

import { CDPHooksProvider } from "@coinbase/cdp-hooks";
import type { Config } from "@coinbase/cdp-core";
import { useMemo } from "react";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { CdpWalletBridge } from "@/components/CdpWalletBridge";
import { setCdpLocked } from "@/lib/cdp-bridge";

/**
 * Standalone Coinbase CDP runtime: headless embedded-wallet provider + bridge,
 * no app children. Loaded lazily (next/dynamic, ssr:false) and mounted only
 * while an email session exists (see providers/index), so visitors never
 * download the SDK.
 *
 * Custom auth (BYO-JWT): customAuth.getJwt hands CDP the JWT our login mints
 * (/api/auth/wallet/jwt); CDP validates it against our JWKS (configured in the
 * CDP dashboard) and provisions non-custodial Solana + EVM embedded wallets
 * keyed to sub = users.id. Headless `@coinbase/cdp-hooks` (NOT `cdp-react`) so
 * there's no CDP login UI — our own email/password AuthModal is the only login.
 * Non-custodial: keys live in Coinbase's TEE, never exposed; user can export.
 */
export default function CdpRuntime() {
  const projectId = process.env.NEXT_PUBLIC_CDP_PROJECT_ID;

  const config = useMemo<Config | null>(() => {
    if (!projectId) return null;
    return {
      projectId,
      ethereum: { createOnLogin: "eoa" },
      solana: { createOnLogin: true },
      customAuth: {
        getJwt: async () => {
          const res = await fetch("/api/auth/wallet/jwt", { method: "POST", headers: sessionAuthHeaders() });
          // 403 { locked }: the account has a second factor and this session
          // has not unlocked the wallet; the bridge asks when the user acts.
          if (res.status === 403) setCdpLocked(Boolean(((await res.json().catch(() => ({}))) as { locked?: boolean }).locked));
          if (!res.ok) return undefined;
          setCdpLocked(false);
          const { jwt } = (await res.json()) as { jwt?: string };
          return jwt;
        },
      },
    };
  }, [projectId]);

  if (!config) return null;

  return (
    <CDPHooksProvider config={config}>
      <CdpWalletBridge />
    </CDPHooksProvider>
  );
}
