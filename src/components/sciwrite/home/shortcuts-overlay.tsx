"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Keyboard, Command, Search, PenLine, Radar, Layers, ListTree, Moon, PanelRight } from "lucide-react";

interface ShortcutGroup {
  title: string;
  shortcuts: { keys: string[]; label: string; icon?: typeof PenLine }[];
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Navigation",
    shortcuts: [
      { keys: ["1"], label: "Research task", icon: Search },
      { keys: ["2"], label: "Draft task", icon: PenLine },
      { keys: ["3"], label: "Compose task", icon: Layers },
      { keys: ["4"], label: "Audit task", icon: Radar },
      { keys: ["5"], label: "Manage task", icon: ListTree },
      { keys: ["⌘", "K"], label: "Command palette", icon: Command },
      { keys: ["?"], label: "Toggle this overlay", icon: Keyboard },
      { keys: ["Esc"], label: "Close dialogs / overlay" },
    ],
  },
  {
    title: "Writing",
    shortcuts: [
      { keys: ["N"], label: "New paragraph (AI Write)", icon: PenLine },
      { keys: ["G"], label: "Gather sources", icon: Search },
      { keys: ["O"], label: "Generate outline", icon: ListTree },
      { keys: ["C"], label: "Compose article (needs 2+ paragraphs)", icon: Layers },
      { keys: ["F"], label: "Full one-click generation", icon: Layers },
    ],
  },
  {
    title: "Project & View",
    shortcuts: [
      { keys: ["I"], label: "Project insights", icon: Radar },
      { keys: ["D"], label: "Toggle dark / light mode", icon: Moon },
    ],
  },
];

export function ShortcutsOverlay({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="canvas-shortcuts-dialog max-w-2xl">
        <DialogHeader>
          <DialogTitle className="canvas-shortcuts-title flex items-center gap-2">
            <Keyboard className="h-4 w-4 text-primary" />
            Keyboard Shortcuts
          </DialogTitle>
          <DialogDescription className="canvas-shortcuts-desc">
            Press <kbd className="canvas-kbd">?</kbd> anywhere to toggle this overlay. Number keys
            <kbd className="canvas-kbd">1</kbd>–<kbd className="canvas-kbd">5</kbd> switch tasks.
          </DialogDescription>
        </DialogHeader>
        <div className="canvas-shortcuts-grid">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title} className="canvas-shortcuts-group">
              <h3 className="canvas-shortcuts-group-title">{group.title}</h3>
              <div className="canvas-shortcuts-list">
                {group.shortcuts.map((s, i) => {
                  const Icon = s.icon;
                  return (
                    <div key={i} className="canvas-shortcut-row">
                      <span className="canvas-shortcut-label">
                        {Icon && <Icon className="h-3 w-3 text-muted-foreground shrink-0" />}
                        {s.label}
                      </span>
                      <span className="canvas-shortcut-keys">
                        {s.keys.map((k, j) => (
                          <kbd key={j} className="canvas-kbd">{k}</kbd>
                        ))}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
