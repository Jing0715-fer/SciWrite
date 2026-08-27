"use client";

import * as React from "react";
import { Loader2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useI18n } from "@/lib/i18n";

export function RevisePopover({
  unresolvedCount,
  isRevising,
  onRevise,
}: {
  unresolvedCount: number;
  isRevising: boolean;
  onRevise: (mode: string, instructions?: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<"annotations" | "instructions" | "polish">("annotations");
  const [instructions, setInstructions] = React.useState("");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-[11px] gap-1.5 btn-gradient-primary text-primary-foreground border-primary/40">
          {isRevising ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Wand2 className="h-3 w-3" />
          )}
          {t("para.aiRevise")}
          {unresolvedCount > 0 && (
            <span className="ml-0.5 inline-flex items-center justify-center h-3.5 min-w-3.5 px-1 rounded-full bg-amber-500 text-white text-[8px] font-bold">
              {unresolvedCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="start">
        <div className="space-y-2.5">
          <span className="text-[10px] uppercase tracking-wider text-primary font-semibold flex items-center gap-1">
            <Wand2 className="h-3 w-3" /> {t("para.revisionMode")}
          </span>
          <div className="grid grid-cols-3 gap-1">
            {(
              [
                ["annotations", t("para.modeAnnotations"), unresolvedCount > 0],
                ["instructions", t("para.modeInstructions"), true],
                ["polish", t("para.modePolish"), true],
              ] as const
            ).map(([id, label, enabled]) => (
              <button
                key={id}
                disabled={!enabled}
                onClick={() => setMode(id)}
                className={`text-[10px] px-2 py-1.5 rounded-md border transition-colors ${
                  mode === id
                    ? "border-primary bg-primary/10 text-primary font-medium"
                    : "border-border hover:bg-muted"
                } ${!enabled ? "opacity-40 cursor-not-allowed" : ""}`}
              >
                {label}
              </button>
            ))}
          </div>
          {mode === "annotations" && (
            <p className="text-[10px] text-muted-foreground">
              {t("para.willAddressAnnotations", { n: unresolvedCount })}
            </p>
          )}
          {mode === "instructions" && (
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={t("para.reviseInstructionsPlaceholder")}
              className="text-xs min-h-[64px]"
            />
          )}
          {mode === "polish" && (
            <p className="text-[10px] text-muted-foreground">
              {t("para.polishDesc")}
            </p>
          )}
          <Button
            size="sm"
            className="w-full h-7 text-[11px] gap-1.5"
            disabled={
              isRevising ||
              (mode === "annotations" && unresolvedCount === 0) ||
              (mode === "instructions" && !instructions.trim())
            }
            onClick={() => {
              onRevise(mode, mode === "instructions" ? instructions.trim() : undefined);
              setOpen(false);
              setInstructions("");
            }}
          >
            {isRevising ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
            {t("para.runRevision")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
