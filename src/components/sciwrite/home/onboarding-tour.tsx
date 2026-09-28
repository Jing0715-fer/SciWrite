"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import {
  FlaskConical,
  FolderOpen,
  Search,
  PenLine,
  Layers,
  Radar,
  Keyboard,
  PanelRight,
  Sparkles,
  ChevronRight,
  ChevronLeft,
  X,
} from "lucide-react";

interface TourStep {
  id: string;
  icon: typeof FlaskConical;
  title: string;
  body: string;
  /** CSS selector for the element to spotlight. If null, shows a centered
   *  welcome/farewell card with no spotlight hole. */
  selector?: string;
  /** Side of the target to place the tooltip card. */
  side?: "bottom" | "top" | "right" | "left";
}

const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    icon: Sparkles,
    title: "Welcome to SciWrite Canvas",
    body: "A task-first writing studio for scientific literature. Instead of fixed panels, the workspace adapts to what you're doing. This 60-second tour shows you the key moves.",
    side: "bottom",
  },
  {
    id: "tasks",
    icon: PenLine,
    title: "5 Tasks, One Focal Workspace",
    body: "Switch between Research, Draft, Compose, Audit, and Manage. Each task gets the full workspace. Press 1–5 on your keyboard to jump.",
    selector: ".canvas-tasknav",
    side: "bottom",
  },
  {
    id: "switcher",
    icon: FolderOpen,
    title: "Project Switcher",
    body: "Click the project name to see all your projects in a dropdown. No sidebar list — the workspace stays focused.",
    selector: ".canvas-project-switcher",
    side: "bottom",
  },
  {
    id: "cmdk",
    icon: Search,
    title: "Command Palette (⌘K)",
    body: "Press ⌘K to open the command palette. Jump to any action — write, gather, compose — without touching the mouse.",
    selector: ".canvas-cmdk-trigger",
    side: "bottom",
  },
  {
    id: "context",
    icon: PanelRight,
    title: "Context Drawer",
    body: "Toggle a slide-in panel with your sources and references. It appears only when you need it — keeping the workspace clean.",
    selector: '[aria-label="Toggle context panel"]',
    side: "bottom",
  },
  {
    id: "shortcuts",
    icon: Keyboard,
    title: "Keyboard Shortcuts (?)",
    body: "Press ? anytime to see all shortcuts. Number keys switch tasks; N writes; G gathers; C composes; D toggles dark mode.",
    selector: '[aria-label="Keyboard shortcuts"]',
    side: "bottom",
  },
  {
    id: "themes",
    icon: Sparkles,
    title: "4 Theme Personalities",
    body: "Each theme has a DIFFERENT visual personality — not just colors. Emerald is classic, Ocean is glassy, Sunset has hard shadows, Violet glows. Try them!",
    side: "bottom",
  },
];

const STORAGE_KEY = "sciwrite:onboarding-completed";

export function OnboardingTour({ forceOpen = false }: { forceOpen?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [step, setStep] = React.useState(0);
  const [mounted, setMounted] = React.useState(false);
  const [targetRect, setTargetRect] = React.useState<DOMRect | null>(null);

  // Allow parent to force-open (e.g. from the Help menu)
  React.useEffect(() => {
    if (forceOpen) {
      setStep(0);
      setOpen(true);
    }
  }, [forceOpen]);

  React.useEffect(() => {
    setMounted(true);
    try {
      const completed = localStorage.getItem(STORAGE_KEY);
      if (!completed) {
        const timer = setTimeout(() => setOpen(true), 800);
        return () => clearTimeout(timer);
      }
    } catch {
      /* storage unavailable */
    }
  }, []);

  // Track the spotlight target element's position
  React.useEffect(() => {
    if (!open) return;
    const current = TOUR_STEPS[step];
    if (!current.selector) {
      setTargetRect(null);
      return;
    }
    const updateRect = () => {
      const el = document.querySelector(current.selector!);
      if (el) {
        setTargetRect(el.getBoundingClientRect());
      } else {
        setTargetRect(null);
      }
    };
    updateRect();
    // Update on resize/scroll
    window.addEventListener("resize", updateRect);
    window.addEventListener("scroll", updateRect, true);
    const interval = setInterval(updateRect, 200); // catch layout shifts
    return () => {
      window.removeEventListener("resize", updateRect);
      window.removeEventListener("scroll", updateRect, true);
      clearInterval(interval);
    };
  }, [open, step]);

  const close = React.useCallback(() => {
    setOpen(false);
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      /* storage unavailable */
    }
  }, []);

  const next = React.useCallback(() => {
    if (step < TOUR_STEPS.length - 1) setStep((s) => s + 1);
    else close();
  }, [step, close]);

  const prev = React.useCallback(() => {
    if (step > 0) setStep((s) => s - 1);
  }, [step]);

  if (!mounted || !open) return null;

  const current = TOUR_STEPS[step];
  const Icon = current.icon;
  const isLast = step === TOUR_STEPS.length - 1;

  // Calculate tooltip position based on target rect
  const tooltipStyle: React.CSSProperties = {};
  if (targetRect) {
    const padding = 12;
    if (current.side === "bottom") {
      tooltipStyle.left = Math.max(
        16,
        Math.min(
          targetRect.left + targetRect.width / 2,
          window.innerWidth - 320 - 16
        )
      );
      tooltipStyle.top = targetRect.bottom + padding;
    } else if (current.side === "top") {
      tooltipStyle.left = Math.max(16, Math.min(targetRect.left, window.innerWidth - 320 - 16));
      tooltipStyle.top = Math.max(16, targetRect.top - 200);
    } else if (current.side === "right") {
      tooltipStyle.left = Math.min(targetRect.right + padding, window.innerWidth - 320 - 16);
      tooltipStyle.top = Math.max(16, targetRect.top);
    } else {
      tooltipStyle.left = Math.max(16, targetRect.left - 320 - padding);
      tooltipStyle.top = Math.max(16, targetRect.top);
    }
  } else {
    // Centered for welcome/farewell steps
    tooltipStyle.left = "50%";
    tooltipStyle.top = "50%";
    tooltipStyle.transform = "translate(-50%, -50%)";
  }

  // Spotlight hole: a box-shadow ring that dims everything outside the target
  const spotlightStyle: React.CSSProperties = {};
  if (targetRect) {
    const r = 8; // border radius of the hole
    spotlightStyle.boxShadow = `0 0 0 9999px color-mix(in oklch, var(--background) 75%, transparent)`;
    spotlightStyle.borderRadius = `${r}px`;
    spotlightStyle.position = "fixed";
    spotlightStyle.left = `${targetRect.left - 4}px`;
    spotlightStyle.top = `${targetRect.top - 4}px`;
    spotlightStyle.width = `${targetRect.width + 8}px`;
    spotlightStyle.height = `${targetRect.height + 8}px`;
    spotlightStyle.zIndex = "60";
    spotlightStyle.pointerEvents = "none";
    spotlightStyle.transition = "all 0.3s cubic-bezier(0.22, 1, 0.36, 1)";
  }

  return createPortal(
    <>
      {/* Backdrop overlay (dims the screen) */}
      {!targetRect && (
        <div
          className="canvas-tour-backdrop"
          onClick={close}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 59,
            background: "color-mix(in oklch, var(--background) 80%, transparent)",
          }}
        />
      )}
      {/* Spotlight hole */}
      {targetRect && <div style={spotlightStyle} className="canvas-tour-spotlight" />}
      {/* Tooltip card */}
      <div
        className="canvas-tour-card"
        style={{
          position: "fixed",
          zIndex: 61,
          width: 320,
          ...tooltipStyle,
        }}
      >
        <button onClick={close} className="canvas-tour-close" aria-label="Skip tour">
          <X className="h-3.5 w-3.5" />
        </button>
        <div className="canvas-tour-card-header">
          <div className="canvas-tour-icon">
            <Icon className="h-4 w-4 text-primary" />
          </div>
          <span className="canvas-tour-step-counter">
            {step + 1} / {TOUR_STEPS.length}
          </span>
        </div>
        <h3 className="canvas-tour-card-title">{current.title}</h3>
        <p className="canvas-tour-card-body">{current.body}</p>
        {/* Progress dots */}
        <div className="canvas-tour-dots">
          {TOUR_STEPS.map((s, i) => (
            <button
              key={s.id}
              onClick={() => setStep(i)}
              className={`canvas-tour-dot ${i === step ? "canvas-tour-dot-active" : ""} ${i < step ? "canvas-tour-dot-done" : ""}`}
              aria-label={`Go to step ${i + 1}`}
            />
          ))}
        </div>
        {/* Footer */}
        <div className="canvas-tour-card-footer">
          <button onClick={close} className="canvas-tour-skip">
            Skip tour
          </button>
          <div className="flex items-center gap-1">
            {step > 0 && (
              <button onClick={prev} className="canvas-tour-nav">
                <ChevronLeft className="h-3.5 w-3.5" />
                Back
              </button>
            )}
            <button onClick={next} className="canvas-cta-btn h-8 px-3 gap-1 text-xs">
              {isLast ? (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  Get started
                </>
              ) : (
                <>
                  Next
                  <ChevronRight className="h-3.5 w-3.5" />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}
