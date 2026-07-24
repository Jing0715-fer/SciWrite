"use client";

import * as React from "react";
import { Languages, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n, type Lang } from "@/lib/i18n";

export function LanguageToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" title={t("app.language")}>
          <Languages className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-32">
        <DropdownMenuItem
          onClick={() => setLang("en" as Lang)}
          className="text-xs gap-2"
        >
          <span className="flex-1">English</span>
          {lang === "en" && <Check className="h-3 w-3 text-primary" />}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setLang("zh" as Lang)}
          className="text-xs gap-2"
        >
          <span className="flex-1">中文</span>
          {lang === "zh" && <Check className="h-3 w-3 text-primary" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
