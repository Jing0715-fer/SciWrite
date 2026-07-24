"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Download,
  FileText,
  FileType2,
  Loader2,
  FileCode2,
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
}

export function ExportMenu({
  type,
  id,
  variant = "ghost",
  size = "sm",
  label,
  hasAnnotations,
}: Props) {
  const { t } = useI18n();
  const [includeAnn, setIncludeAnn] = React.useState(true);

  const exportMut = useMutation({
    mutationFn: async (format: "docx" | "pdf" | "markdown") => {
      const blob = await api.exportDoc({
        type,
        id,
        format,
        includeAnnotations: hasAnnotations ? includeAnn : false,
      });
      const ext = format === "markdown" ? "md" : format;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sciwrite-export.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    onSuccess: (_d, format) => {
      toast.success(t("export.exportedAs", { fmt: format.toUpperCase() }));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size} className="gap-1.5 text-[11px]">
          <Download className="h-3.5 w-3.5" />
          {label || t("common.export")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {t("export.format")}
        </DropdownMenuLabel>
        <DropdownMenuItem
          onClick={() => exportMut.mutate("docx")}
          disabled={exportMut.isPending}
        >
          <FileType2 className="h-3.5 w-3.5 text-blue-600" />
          <span className="text-xs">{t("export.word")}</span>
          {exportMut.isPending && (
            <Loader2 className="h-3 w-3 animate-spin ml-auto" />
          )}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => exportMut.mutate("pdf")}
          disabled={exportMut.isPending}
        >
          <FileText className="h-3.5 w-3.5 text-rose-600" />
          <span className="text-xs">{t("export.pdf")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => exportMut.mutate("markdown")}
          disabled={exportMut.isPending}
        >
          <FileCode2 className="h-3.5 w-3.5 text-emerald-600" />
          <span className="text-xs">{t("export.markdown")}</span>
        </DropdownMenuItem>
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
