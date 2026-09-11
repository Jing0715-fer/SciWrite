import type { Metadata } from "next";
import "./globals.css";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "SciWrite — AI Research Literature Writing Assistant",
  description:
    "An AI-powered scientific literature writing assistant. Query RCSB, UniProt, PubMed, NCBI and BLAST, then let AI draft, annotate, revise and compose publication-grade paragraphs and articles with proper citations.",
  keywords: [
    "scientific writing",
    "literature assistant",
    "RCSB",
    "UniProt",
    "PubMed",
    "NCBI",
    "BLAST",
    "AI writing",
    "research",
    "citations",
  ],
  authors: [{ name: "SciWrite" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "SciWrite — AI Research Writing Assistant",
    description:
      "Query biological databases, draft scholarly paragraphs with citations, annotate, revise, and compose deeper articles.",
    type: "website",
  },
};

// System-font approach — no external Google Fonts fetch (sandbox-safe).
// Font stacks are defined in globals.css via --font-sans/mono/serif-stack.
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground">
        <Providers>
          {children}
          <SonnerToaster richColors closeButton position="bottom-right" />
        </Providers>
      </body>
    </html>
  );
}
