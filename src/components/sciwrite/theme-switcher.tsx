"use client";

import * as React from "react";
import { Palette } from "lucide-react";

const THEMES = [
  { id: "default", label: "Emerald", color: "#0d9488" },
  { id: "ocean", label: "Ocean", color: "#3b82f6" },
  { id: "sunset", label: "Sunset", color: "#f97316" },
  { id: "violet", label: "Violet", color: "#8b5cf6" },
];

const STORAGE_KEY = "sciwrite-theme";

export function ThemeSwitcher() {
  const [current, setCurrent] = React.useState<string>("default");

  const applyTheme = React.useCallback((themeId: string) => {
    const root = document.documentElement;
    if (themeId === "default") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", themeId);
    }
  }, []);

  React.useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY) || "default";
    setCurrent(saved);
    applyTheme(saved);
  }, [applyTheme]);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const themeId = e.target.value;
    setCurrent(themeId);
    applyTheme(themeId);
    localStorage.setItem(STORAGE_KEY, themeId);
  };

  return (
    <div className="flex items-center gap-1">
      <Palette className="h-3.5 w-3.5 text-muted-foreground" />
      <select
        value={current}
        onChange={handleChange}
        className="text-[10px] bg-transparent border-none outline-none cursor-pointer text-muted-foreground hover:text-foreground"
        title="Theme color"
      >
        {THEMES.map((t) => (
          <option key={t.id} value={t.id}>{t.label}</option>
        ))}
      </select>
    </div>
  );
}
