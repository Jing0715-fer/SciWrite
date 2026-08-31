"use client";

import {
  MessageSquare,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ANNOTATION_TYPES, SEVERITY_STYLES } from "@/lib/constants";
import type { Annotation } from "@/lib/types";
import { Icon } from "../icon";
import { useI18n } from "@/lib/i18n";

const ANN_CARD_CLASS: Record<string, string> = {
  emerald: "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/20",
  teal: "border-teal-200 bg-teal-50/50 dark:border-teal-900/50 dark:bg-teal-950/20",
  amber: "border-amber-200 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-950/20",
  rose: "border-rose-200 bg-rose-50/50 dark:border-rose-900/50 dark:bg-rose-950/20",
  violet: "border-violet-200 bg-violet-50/50 dark:border-violet-900/50 dark:bg-violet-950/20",
  sky: "border-sky-200 bg-sky-50/50 dark:border-sky-900/50 dark:bg-sky-950/20",
};

interface AnnotationsSectionProps {
  annotations: Annotation[];
  annOpen: boolean;
  setAnnOpen: (open: boolean) => void;
  resolveAnnMut: { mutate: (input: { id: string; resolved: boolean }) => void };
  deleteAnnMut: { mutate: (id: string) => void };
}

export function AnnotationsSection({
  annotations,
  annOpen,
  setAnnOpen,
  resolveAnnMut,
  deleteAnnMut,
}: AnnotationsSectionProps) {
  const { t } = useI18n();

  return (
    <Collapsible open={annOpen} onOpenChange={setAnnOpen} className="border-t hairline">
      <div className="glass-subtle px-4 py-2 flex items-center justify-between">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5">
            <MessageSquare className="h-3.5 w-3.5" />
            {t("para.annotationsCount", { n: annotations.length })}
            {annOpen ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="px-4 py-3 space-y-2 bg-muted/20">
          {annotations.map((a) => {
            const meta = ANNOTATION_TYPES.find((t) => t.id === a.type) || ANNOTATION_TYPES[0];
            const sev = SEVERITY_STYLES[a.severity as keyof typeof SEVERITY_STYLES] || SEVERITY_STYLES.info;
            return (
              <div
                key={a.id}
                // round-38: dropped `surface-card` from this element — it is
                // UNLAYERED CSS, so its background-color beat the ANN_CARD_CLASS
                // bg tints (bg-emerald-50/50 etc. never rendered; every card
                // showed plain var(--card)). Border + shadow utilities alone
                // keep the frame, so the per-type color now actually shows.
                className={`rounded-md border p-2.5 text-xs shadow-xs ${
                  a.resolved ? "opacity-60" : ""
                } ${ANN_CARD_CLASS[meta.color] || "border-border bg-muted/30"}`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <Icon name={meta.icon} className="h-3 w-3" />
                  <span className="font-semibold text-[10px] uppercase tracking-wide">
                    {meta.label}
                  </span>
                  <span className={`badge-${sev.color} px-1 py-0.5 rounded text-[8px] uppercase`}>
                    {sev.label}
                  </span>
                  {a.resolved && (
                    <span className="text-[9px] text-emerald-600 dark:text-emerald-400 flex items-center gap-0.5">
                      <CheckCircle2 className="h-2.5 w-2.5" /> {t("para.resolved")}
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      onClick={() =>
                        resolveAnnMut.mutate({ id: a.id, resolved: !a.resolved })
                      }
                      title={a.resolved ? t("para.reopen") : t("para.resolve")}
                    >
                      <CheckCircle2 className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 text-destructive"
                      onClick={() => deleteAnnMut.mutate(a.id)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
                {a.selectedText && (
                  <p className="text-[10px] italic text-muted-foreground mb-1 line-clamp-1">
                    “{a.selectedText}”
                  </p>
                )}
                <p className="text-foreground/90">{a.comment}</p>
                {a.aiResponse && (
                  <p className="mt-1.5 text-[10px] text-primary italic border-l-2 border-primary/40 pl-2">
                    {t("para.aiPrefix")} {a.aiResponse}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
