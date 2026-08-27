"use client";

// Confirmation dialog for "Regenerate all" — rewriting all paragraphs is
// destructive (replaces the current body text), so we double-confirm.
// Shows the count of paragraphs that will be regenerated.
// Extracted verbatim from citation-health-dashboard.tsx (round 6-c split).

import { RotateCw } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { useI18n } from "@/lib/i18n";

export function RegenConfirmDialog({
  open,
  onOpenChange,
  offenderCount,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  offenderCount: number;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-base font-serif-text tracking-tight">
            <RotateCw className="h-5 w-5 text-primary shrink-0" />
            {t("citationHealth.regenConfirmTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-sm leading-relaxed space-y-2">
            <span className="block">
              {t("citationHealth.regenBodyPrefix")}{" "}
              <strong className="text-foreground font-serif-text">
                {t("citationHealth.regenParagraphsCount", {
                  n: offenderCount,
                })}
              </strong>{" "}
              {t("citationHealth.regenBodySuffix")}
            </span>
            <span className="block text-amber-600 dark:text-amber-400">
              ⚠ {t("citationHealth.regenWarning")}
            </span>
            <span className="block text-muted-foreground text-xs">
              {t("citationHealth.regenNote")}
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="text-xs">
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            className="text-xs gap-1.5 btn-gradient-primary text-primary-foreground hover:shadow-md transition-all"
            onClick={(e) => {
              e.preventDefault();
              onOpenChange(false);
              onConfirm();
            }}
          >
            <RotateCw className="h-3.5 w-3.5" />
            {t("citationHealth.regenerateAll")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
