"use client";

import { FlaskConical } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export function EmptyWorkspace() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6 acad-fade-in">
      {/* round-31: hero moment — larger brand tile with a soft radial glow
          bleeding from behind it so the icon reads as a lit object, not
          placeholder clipart. */}
      <div className="relative mb-5">
        <div
          aria-hidden
          className="absolute -inset-8 bg-primary/[0.07] blur-2xl rounded-full"
        />
        <div className="relative brand-tile h-24 w-24 rounded-[1.75rem] flex items-center justify-center ring-academic">
          <FlaskConical className="h-11 w-11 text-primary-foreground" />
        </div>
      </div>
      <h2 className="text-[1.75rem] font-semibold font-serif-text tracking-tight">
        {t("workspace.emptyTitle")}
      </h2>
      <p className="text-sm text-muted-foreground mt-2.5 max-w-md leading-relaxed">
        {t("workspace.emptyDesc")}
      </p>
      <div className="mt-8 grid grid-cols-3 gap-3 max-w-lg text-[11px]">
        {[
          ["1", t("workspace.step1Title"), t("workspace.step1Desc")],
          ["2", t("workspace.step2Title"), t("workspace.step2Desc")],
          ["3", t("workspace.step3Title"), t("workspace.step3Desc")],
        ].map(([n, title, desc]) => (
          <div
            key={n}
            className="surface-card rounded-xl p-4 text-left hover:-translate-y-0.5 hover:shadow-md! transition-all duration-200"
          >
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="h-6 w-6 rounded-lg bg-primary/12 text-primary text-[10px] font-bold flex items-center justify-center">
                {n}
              </span>
              <span className="font-semibold text-[11px]">{title}</span>
            </div>
            <p className="text-[10px] text-muted-foreground leading-relaxed">{desc}</p>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground/80 mt-6">
        {t("workspace.emptyHint")}
      </p>
    </div>
  );
}
