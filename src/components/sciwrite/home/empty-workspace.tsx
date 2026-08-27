"use client";

import { FlaskConical } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export function EmptyWorkspace() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6 acad-fade-in">
      <div className="brand-tile h-20 w-20 rounded-3xl flex items-center justify-center mb-4 ring-academic">
        <FlaskConical className="h-10 w-10 text-primary-foreground" />
      </div>
      <h2 className="text-2xl font-semibold font-serif-text tracking-tight">
        {t("workspace.emptyTitle")}
      </h2>
      <p className="text-sm text-muted-foreground mt-2 max-w-md leading-relaxed">
        {t("workspace.emptyDesc")}
      </p>
      <div className="mt-5 grid grid-cols-3 gap-2.5 max-w-lg text-[11px]">
        {[ 
          ["1", t("workspace.step1Title"), t("workspace.step1Desc")],
          ["2", t("workspace.step2Title"), t("workspace.step2Desc")],
          ["3", t("workspace.step3Title"), t("workspace.step3Desc")],
        ].map(([n, title, desc]) => (
          <div key={n} className="surface-card rounded-lg p-3 text-left hover:shadow-md transition-shadow">
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="h-5 w-5 rounded-md bg-primary/15 text-primary text-[10px] font-bold flex items-center justify-center">
                {n}
              </span>
              <span className="font-semibold text-[11px]">{title}</span>
            </div>
            <p className="text-[10px] text-muted-foreground leading-snug">{desc}</p>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground/80 mt-5">
        {t("workspace.emptyHint")}
      </p>
    </div>
  );
}
