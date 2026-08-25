import type { Metadata } from "next";
import { Geist, Geist_Mono, Lora, Noto_Serif_SC, Noto_Sans_SC } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { Providers } from "@/components/providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const lora = Lora({
  variable: "--font-serif",
  subsets: ["latin"],
  display: "swap",
});

// Chinese fonts for beautiful CJK rendering.
// Noto Serif SC = 中文衬线（用于学术正文，与 Lora 衬线风格搭配）
// Noto Sans SC = 中文无衬线（用于 UI 界面，与 Geist Sans 搭配）
// weight 选择精简以控制加载大小：正文 400/600，标题 700。
const notoSerifSC = Noto_Serif_SC({
  variable: "--font-zh-serif",
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  display: "swap",
});

const notoSansSC = Noto_Sans_SC({
  variable: "--font-zh-sans",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
});

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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${lora.variable} ${notoSerifSC.variable} ${notoSansSC.variable} antialiased bg-background text-foreground`}
      >
        <Providers>
          {children}
          <Toaster />
          <SonnerToaster richColors closeButton position="bottom-right" />
        </Providers>
      </body>
    </html>
  );
}
