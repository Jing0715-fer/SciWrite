"use client";

import * as React from "react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Sparkles,
  Radar,
  Layers,
  BarChart3,
  PenLine,
  Download,
  Moon,
  Sun,
  FlaskConical,
  Plus,
  Keyboard,
} from "lucide-react";

interface CommandAction {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  shortcut?: string;
  onSelect: () => void;
  group: string;
  disabled?: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  actions: Omit<CommandAction, "group">[];
}

export function CommandPalette({ open, onOpenChange, actions }: Props) {
  const grouped = React.useMemo(() => {
    const groups: Record<string, CommandAction[]> = {};
    for (const a of actions) {
      const g = a.group || "Actions";
      if (!groups[g]) groups[g] = [];
      groups[g].push(a as CommandAction);
    }
    return groups;
  }, [actions]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} className="max-w-xl">
      <CommandInput placeholder="Type a command or search…" />
      <CommandList className="max-h-[400px]">
        <CommandEmpty>No results found.</CommandEmpty>
        {Object.entries(grouped).map(([group, items], gi) => (
          <React.Fragment key={group}>
            {gi > 0 && <CommandSeparator />}
            <CommandGroup heading={group}>
              {items.map((a) => (
                <CommandItem
                  key={a.id}
                  value={`${a.label} ${a.hint || ""}`}
                  onSelect={() => {
                    a.onSelect();
                    onOpenChange(false);
                  }}
                  disabled={a.disabled}
                  className="gap-2"
                >
                  <span className="text-primary shrink-0">{a.icon}</span>
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-xs font-medium">{a.label}</span>
                    {a.hint && (
                      <span className="text-[10px] text-muted-foreground truncate">
                        {a.hint}
                      </span>
                    )}
                  </div>
                  {a.shortcut && (
                    <CommandShortcut>{a.shortcut}</CommandShortcut>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </React.Fragment>
        ))}
        <CommandSeparator />
        <CommandGroup heading="Shortcuts">
          <div className="px-2 py-1.5 grid grid-cols-2 gap-1.5 text-[10px] text-muted-foreground">
            <ShortcutRow keys="⌘K" desc="Open command palette" />
            <ShortcutRow keys="N" desc="New paragraph (AI Write)" />
            <ShortcutRow keys="O" desc="Generate research outline" />
            <ShortcutRow keys="G" desc="Gather sources" />
            <ShortcutRow keys="I" desc="Project insights" />
            <ShortcutRow keys="C" desc="Compose article" />
            <ShortcutRow keys="D" desc="Toggle dark mode" />
            <ShortcutRow keys="Esc" desc="Close dialog" />
          </div>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

function ShortcutRow({ keys, desc }: { keys: string; desc: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <kbd className="px-1.5 py-0.5 rounded bg-muted border border-border font-mono text-[9px] font-semibold">
        {keys}
      </kbd>
      <span>{desc}</span>
    </div>
  );
}
