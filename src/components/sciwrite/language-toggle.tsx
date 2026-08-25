"use client";

import * as React from "react";
import { Languages, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n, type Lang, langNativeNames, langLocales } from "@/lib/i18n";

/**
 * LanguageToggle — dropdown to switch the UI language.
 *
 * Supports 5 languages: English, 中文, 日本語, 한국어, Français.
 * Each item shows the native name + a check mark for the active language.
 * The footer shows the active BCP-47 locale tag (used by Intl formatting).
 *
 * Languages with partial translations (ja/ko/fr) fall back to English
 * for untranslated keys — see lib/i18n.tsx.
 */
const LANG_ORDER: Lang[] = ["en", "zh", "ja", "ko", "fr"];

export function LanguageToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-2.5 rounded-full transition-all hover:bg-primary/10 hover:text-primary"
          title={t("app.language")}
          aria-label={t("app.language")}
        >
          <Languages className="h-4 w-4" />
          <span className="text-xs font-medium hidden sm:inline">
            {langNativeNames[lang]}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t("app.language")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {LANG_ORDER.map((l) => (
          <DropdownMenuItem
            key={l}
            onClick={() => setLang(l)}
            className="text-sm gap-2 cursor-pointer"
          >
            <span className="flex-1">{langNativeNames[l]}</span>
            <span className="text-[10px] text-muted-foreground uppercase">
              {l}
            </span>
            {lang === l && <Check className="h-3.5 w-3.5 text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <div className="px-2 py-1 text-[10px] text-muted-foreground">
          Locale: <span className="font-mono">{langLocales[lang]}</span>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
