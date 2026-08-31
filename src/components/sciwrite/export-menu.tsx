"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Download,
  FileText,
  FileType2,
  Loader2,
  FileCode2,
  Languages,
  BookOpen,
  Network,
  FileTerminal,
  Library,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api-client";
import { useMutation } from "@tanstack/react-query";
import { useI18n } from "@/lib/i18n";

interface Props {
  type: "paragraph" | "article";
  id: string;
  variant?: "ghost" | "outline" | "default";
  size?: "sm" | "icon" | "default";
  label?: string;
  hasAnnotations?: boolean;
  /** When true, the article has a Chinese version (contentZh) available. */
  hasZh?: boolean;
}

type ExportLang = "en" | "zh" | "both";
type ExportFormat =
  | "docx"
  | "pdf"
  | "markdown"
  | "latex"
  | "epub"
  | "graph-report"
  | "endnote";

/**
 * Metadata for each export format — drives the menu rendering.
 * `langs` controls which language variants are offered for that format.
 * EPUB and Graph Report are language-agnostic (always "en" content).
 */
const FORMAT_META: {
  format: ExportFormat;
  icon: any;
  color: string;
  key: string;
  ext: string;
  langs?: ExportLang[]; // undefined = all langs available
  desc: string; // v102-3: short description shown in menu
}[] = [
  { format: "docx", icon: FileType2, color: "text-blue-600 dark:text-blue-400", key: "export.word", ext: "docx", desc: "Microsoft Word" },
  { format: "pdf", icon: FileText, color: "text-rose-600 dark:text-rose-400", key: "export.pdf", ext: "pdf", desc: "Portable Document" },
  { format: "endnote", icon: Library, color: "text-teal-600 dark:text-teal-400", key: "export.endnote", ext: "enw", langs: ["en"], desc: "EndNote library import" },
  { format: "markdown", icon: FileCode2, color: "text-emerald-600 dark:text-emerald-400", key: "export.markdown", ext: "md", desc: "Plain text .md" },
  { format: "latex", icon: FileTerminal, color: "text-amber-700 dark:text-amber-300", key: "export.latex", ext: "tex", desc: "LaTeX source" },
  { format: "epub", icon: BookOpen, color: "text-indigo-600 dark:text-indigo-400", key: "export.epub", ext: "epub", langs: ["en"], desc: "E-book" },
  { format: "graph-report", icon: Network, color: "text-fuchsia-600 dark:text-fuchsia-400", key: "export.graphReport", ext: "html", langs: ["en"], desc: "Citation graph" },
];

const LANG_META: Record<ExportLang, { label: string; short: string; suffix: string }> = {
  en: { label: "English version", short: "EN", suffix: "" },
  zh: { label: "中文版本", short: "中", suffix: "-zh" },
  both: { label: "EN + 中文 (both)", short: "⇄", suffix: "-bilingual" },
};

export function ExportMenu({
  type,
  id,
  variant = "ghost",
  size = "sm",
  label,
  hasAnnotations,
  hasZh,
}: Props) {
  const { t } = useI18n();
  const [includeAnn, setIncludeAnn] = React.useState(true);
  const [pending, setPending] = React.useState<string | null>(null);
  const [exportProgress, setExportProgress] = React.useState<string | null>(null);

  const exportMut = useMutation({
    mutationFn: async ({ format, language }: { format: ExportFormat; language: ExportLang }) => {
      const meta = FORMAT_META.find((f) => f.format === format)!;
      setExportProgress(`Preparing ${meta.ext.toUpperCase()}...`);
      const blob = await api.exportDoc({
        type,
        id,
        format,
        includeAnnotations: hasAnnotations ? includeAnn : false,
        language,
      });
      setExportProgress("Downloading...");
      // v116: use the server-provided filename (article title + timestamp)
      // instead of a fixed "sciwrite-export" name. Falls back to the old
      // fixed name if the header was missing for any reason.
      const serverName = (blob as any).__filename as string | undefined;
      const langSuffix = LANG_META[language].suffix;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = serverName || `sciwrite-export${langSuffix}.${meta.ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportProgress(null);
    },
    onMutate: (vars) => {
      setPending(`${vars.format}:${vars.language}`);
    },
    onSettled: () => {
      setPending(null);
      setExportProgress(null);
    },
    onSuccess: (blob: any, { format, language }) => {
      const langLabel = language === "zh" ? " (中文)" : language === "both" ? " (EN+中文)" : "";
      toast.success(t("export.exportedAs", { fmt: format.toUpperCase() }) + langLabel);
      // Show export validation warnings if any references had missing fields
      if (blob?.__exportWarnings) {
        toast.warning(`Some references have incomplete metadata: ${blob.__exportWarnings}`, {
          duration: 10000,
        });
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const renderFormatItem = (
    format: ExportFormat,
    language: ExportLang,
    Icon: any,
    iconColor: string,
    label: string,
    desc?: string, // v102-3: optional description
  ) => {
    const itemKey = `${format}:${language}`;
    const isLoading = exportMut.isPending && pending === itemKey;
    return (
      <DropdownMenuItem
        key={itemKey}
        onClick={() => exportMut.mutate({ format, language })}
        disabled={exportMut.isPending}
        className="gap-2 py-1.5"
      >
        <Icon className={`h-3.5 w-3.5 shrink-0 ${iconColor}`} />
        <div className="flex flex-col min-w-0">
          <span className="text-xs">{label}</span>
          {desc && (
            <span className="text-[9px] text-muted-foreground leading-tight">{desc}</span>
          )}
        </div>
        {isLoading && (
          <span className="ml-auto flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span className="text-[9px] text-muted-foreground">{exportProgress}</span>
          </span>
        )}
      </DropdownMenuItem>
    );
  };

  // Build the list of formats for the non-bilingual (single lang) menu.
  // All 6 formats are offered with the "en" language variant.
  const renderSingleLangFormats = (language: ExportLang) =>
    FORMAT_META.map((f) => {
      const langs = f.langs || [language];
      if (!langs.includes(language)) return null;
      return renderFormatItem(f.format, language, f.icon, f.color, t(f.key as any), f.desc);
    });

  // If hasZh is false, use the simple single-language menu (legacy behavior)
  if (!hasZh) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant={variant} size={size} className="gap-1.5 text-[11px] transition-all hover:shadow-sm">
            <Download className="h-3.5 w-3.5" />
            {label || t("common.export")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52 rounded-lg border-border/60 shadow-md">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            {t("export.format")}
          </DropdownMenuLabel>
          {renderSingleLangFormats("en")}
          {hasAnnotations && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={includeAnn}
                onCheckedChange={setIncludeAnn}
                className="text-[11px]"
              >
                {t("export.includeAnnotations")}
              </DropdownMenuCheckboxItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  // Bilingual menu — three groups: English, Chinese, Both
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size} className="gap-1.5 text-[11px]">
          <Download className="h-3.5 w-3.5" />
          {label || t("common.export")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60 max-h-[70vh] overflow-y-auto">
        {/* English group */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <span className="text-base font-bold leading-none">EN</span>
            <span className="font-normal text-[9px]">{LANG_META.en.label}</span>
          </DropdownMenuLabel>
          {FORMAT_META.map((f) => {
            const langs = f.langs || ["en"];
            if (!langs.includes("en")) return null;
            return renderFormatItem(f.format, "en", f.icon, f.color, t(f.key as any), f.desc);
          })}
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        {/* Chinese group — excludes language-agnostic formats (epub, graph-report) */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <span className="text-base font-bold leading-none">中</span>
            <span className="font-normal text-[9px]">{LANG_META.zh.label}</span>
          </DropdownMenuLabel>
          {FORMAT_META.filter((f) => !f.langs).map((f) =>
            renderFormatItem(f.format, "zh", f.icon, f.color, t(f.key as any), f.desc),
          )}
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        {/* Bilingual group */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <Languages className="h-3 w-3" />
            <span className="font-normal text-[9px]">{LANG_META.both.label}</span>
          </DropdownMenuLabel>
          {FORMAT_META.filter((f) => !f.langs).map((f) =>
            renderFormatItem(f.format, "both", f.icon, "text-fuchsia-600 dark:text-fuchsia-400", t(f.key as any), f.desc),
          )}
        </DropdownMenuGroup>

        {hasAnnotations && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={includeAnn}
              onCheckedChange={setIncludeAnn}
              className="text-[11px]"
            >
              {t("export.includeAnnotations")}
            </DropdownMenuCheckboxItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
