"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/components/theme-provider";
import { I18nProvider } from "@/lib/i18n";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Single-user local app: 60s freshness is plenty and cuts
            // redundant refetches (was 15s — every panel remount re-fetched).
            staleTime: 60_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  );
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      <I18nProvider>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
