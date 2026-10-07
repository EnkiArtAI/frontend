"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { useState } from "react";
import { getQueryFn } from "@/lib/queryClient";
import { ThirdwebProvider } from "./ThirdwebProvider";
import { ThemeProvider } from "./ThemeProvider";
import { SolanaWalletProvider } from "./SolanaWalletProvider";

import dynamic from "next/dynamic";
import { useEmailAuth } from "@/hooks/useEmailAuth";

// The CDP SDK is heavy, so it loads lazily and mounts only while an email
// session exists — visitors and wallet-only users never download it.
const CdpRuntime = dynamic(() => import("./CdpProvider"), { ssr: false });

// One runtime per account: another account's login remounts it, and the new
// bridge signs in to CDP itself (see CdpWalletBridge).
function CdpLauncher() {
  const { email } = useEmailAuth();
  return email ? <CdpRuntime key={email} email={email} /> : null;
}
import { Toaster } from "@/components/ui/toaster";
import BetaGate from "@/components/BetaGate";
import { StepUpProvider } from "@/components/StepUpProvider";

/**
 * Provider hierarchy (outermost first):
 *
 *   ThemeProvider          ← theme must survive wallet re-renders
 *     QueryClientProvider  ← data fetching
 *       ThirdwebProvider   ← wallet + x402
 *         TooltipProvider  ← UI
 *
 * ThemeProvider is outermost so that wallet connect/disconnect
 * never causes a theme flash or reset.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            queryFn: getQueryFn({ on401: "throw" }),
            refetchInterval: false,
            refetchOnWindowFocus: false,
            staleTime: Infinity,
            retry: false,
          },
          mutations: {
            retry: false,
          },
        },
      })
  );

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ThirdwebProvider>

            <SolanaWalletProvider>
              <TooltipProvider>
                {/* Closed-beta wall around EVERY page (public paths excepted). */}
                <StepUpProvider>
                  <BetaGate>{children}</BetaGate>
                  {/* Inside the step-up provider: the wallet unlock asks through its dialog. */}
                  <CdpLauncher />
                </StepUpProvider>
                {/* Without this, every toast() (errors included) went nowhere. */}
                <Toaster />
              </TooltipProvider>
            </SolanaWalletProvider>

        </ThirdwebProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
