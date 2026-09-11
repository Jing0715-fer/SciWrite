"use client";

import { FlaskConical, Database, PenLine, Layers, ArrowRight } from "lucide-react";
import { useI18n } from "@/lib/i18n";

/**
 * EmptyWorkspace — redesigned as a "first-run guided canvas".
 *
 * Architectural changes:
 * 1. Instead of a centered icon + text + 3-step grid, this is now a
 *    full-bleed editorial layout: a large left-aligned hero column with
 *    the brand narrative, and a right-side "workflow preview" that shows
 *    the 3 stages as connected nodes (Gather → Draft → Compose) — visually
 *    communicating the app's pipeline rather than abstract numbered cards.
 * 2. The 3 steps are no longer equal-sized cards; they're a vertical
 *    pipeline with connectors, each step showing its tool icon in a
 *    theme-shaped tile.
 */
export function EmptyWorkspace() {
  const { t } = useI18n();
  return (
    <div className="atlas-empty-canvas h-full w-full flex items-stretch acad-fade-in">
      {/* Left hero column */}
      <div className="flex-1 flex flex-col justify-center px-8 sm:px-12 lg:px-16 py-10 min-w-0">
        <div className="atlas-empty-eyebrow">
          <span className="atlas-empty-dot" />
          {t("app.subtitle")}
        </div>
        <h2 className="atlas-empty-title mt-4">
          {t("workspace.emptyTitle")}
        </h2>
        <p className="atlas-empty-lead mt-4 max-w-md">
          {t("workspace.emptyDesc")}
        </p>
        <p className="atlas-empty-hint mt-6">
          {t("workspace.emptyHint")}
        </p>
      </div>

      {/* Right pipeline preview */}
      <div className="atlas-empty-pipeline hidden lg:flex flex-col justify-center px-12 py-10">
        <div className="atlas-empty-pipeline-label">
          The workflow
        </div>
        <div className="mt-6 flex flex-col gap-0">
          {[
            {
              icon: Database,
              n: "01",
              title: t("workspace.step1Title"),
              desc: t("workspace.step1Desc"),
            },
            {
              icon: PenLine,
              n: "02",
              title: t("workspace.step2Title"),
              desc: t("workspace.step2Desc"),
            },
            {
              icon: Layers,
              n: "03",
              title: t("workspace.step3Title"),
              desc: t("workspace.step3Desc"),
            },
          ].map((step, i) => {
            const Icon = step.icon;
            return (
              <div key={step.n} className="atlas-empty-step">
                <div className="atlas-empty-step-marker">
                  <span className="atlas-empty-step-num">{step.n}</span>
                  <Icon className="h-4 w-4 text-primary" />
                </div>
                <div className="atlas-empty-step-body">
                  <div className="atlas-empty-step-title">{step.title}</div>
                  <div className="atlas-empty-step-desc">{step.desc}</div>
                </div>
                {i < 2 && <div className="atlas-empty-step-connector" />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
