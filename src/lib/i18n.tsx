"use client";

import * as React from "react";

export type Lang = "en" | "zh";

export const translations = {
  en: {
    // Header
    "app.title": "SciWrite",
    "app.subtitle": "AI Research Writer",
    "app.tagline": "RCSB · UniProt · PubMed · NCBI · BLAST — citation-grade drafting",
    "app.insights": "Insights",
    "app.outline": "Outline",
    "app.gather": "Gather",
    "app.compose": "Compose",
    "app.aiWrite": "AI Write",
    "app.tips": "Tips",
    "app.noProject": "No project selected",
    "app.dark": "Switch to dark",
    "app.light": "Switch to light",

    // Projects sidebar
    "projects.title": "Projects",
    "projects.new": "New",
    "projects.backup": "Backup",
    "projects.empty": "No projects yet.",
    "projects.emptyHint": "Click “New” to start a research project.",

    // Writing workspace
    "workspace.startWriting": "Start writing",
    "workspace.startHint": "Use “AI Write” to draft your first citation-backed paragraph from your topic, or query databases on the right to gather sources.",
    "workspace.draftFirst": "Draft first paragraph",
    "workspace.paragraphs": "Paragraphs",
    "workspace.dragReorder": "drag ⠿ to reorder",
    "workspace.draftAnother": "Draft another paragraph",
    "workspace.gatherSources": "Gather sources",
    "workspace.writingProgress": "Writing progress",

    // Database panel
    "db.title": "Scientific Databases",
    "db.search": "Search",
    "db.blast": "BLAST",
    "db.try": "Try:",
    "db.noResults": "Query a database to retrieve papers, structures, sequences, or genes.",

    // Knowledge panel
    "knowledge.sources": "Sources",
    "knowledge.refs": "Refs",
    "knowledge.articles": "Articles",
    "knowledge.noSources": "No saved sources",
    "knowledge.noSourcesHint": "Query a database and click “+ Source” to pin records here.",
    "knowledge.noRefs": "No references yet",
    "knowledge.noRefsHint": "Save references from database results or add manually.",
    "knowledge.noArticles": "No composed articles",
    "knowledge.noArticlesHint": "Select paragraphs and use “Compose” to generate a deeper article.",
    "knowledge.addReference": "Add reference",

    // Footer
    "footer.aiPowered": "AI-powered · citation-grade",
    "footer.citations": "Inline citations",
    "footer.commands": "commands",

    // Common
    "common.save": "Save",
    "common.cancel": "Cancel",
    "common.delete": "Delete",
    "common.edit": "Edit",
    "common.preview": "Preview",
    "common.export": "Export",
    "common.close": "Close",
  },
  zh: {
    // Header
    "app.title": "SciWrite",
    "app.subtitle": "AI 科研写作助手",
    "app.tagline": "RCSB · UniProt · PubMed · NCBI · BLAST — 专业引用写作",
    "app.insights": "洞察",
    "app.outline": "大纲",
    "app.gather": "收集",
    "app.compose": "组合",
    "app.aiWrite": "AI 写作",
    "app.tips": "技巧",
    "app.noProject": "未选择项目",
    "app.dark": "切换深色",
    "app.light": "切换浅色",

    // Projects sidebar
    "projects.title": "项目",
    "projects.new": "新建",
    "projects.backup": "备份",
    "projects.empty": "暂无项目。",
    "projects.emptyHint": "点击“新建”开始一个科研项目。",

    // Writing workspace
    "workspace.startWriting": "开始写作",
    "workspace.startHint": "使用“AI 写作”根据您的主题起草首个带引用的段落，或在右侧查询数据库收集数据源。",
    "workspace.draftFirst": "起草第一个段落",
    "workspace.paragraphs": "段落",
    "workspace.dragReorder": "拖拽 ⠿ 重新排序",
    "workspace.draftAnother": "起草另一个段落",
    "workspace.gatherSources": "收集数据源",
    "workspace.writingProgress": "写作进度",

    // Database panel
    "db.title": "科学数据库",
    "db.search": "搜索",
    "db.blast": "BLAST",
    "db.try": "试试：",
    "db.noResults": "查询数据库以检索论文、结构、序列或基因。",

    // Knowledge panel
    "knowledge.sources": "数据源",
    "knowledge.refs": "引用",
    "knowledge.articles": "文章",
    "knowledge.noSources": "无已保存数据源",
    "knowledge.noSourcesHint": "查询数据库并点击“+ 数据源”在此固定记录。",
    "knowledge.noRefs": "暂无引用",
    "knowledge.noRefsHint": "从数据库结果保存引用或手动添加。",
    "knowledge.noArticles": "无组合文章",
    "knowledge.noArticlesHint": "选择段落并使用“组合”生成更深入的文章。",
    "knowledge.addReference": "添加引用",

    // Footer
    "footer.aiPowered": "AI 驱动 · 专业引用",
    "footer.citations": "内联引用",
    "footer.commands": "命令",

    // Common
    "common.save": "保存",
    "common.cancel": "取消",
    "common.delete": "删除",
    "common.edit": "编辑",
    "common.preview": "预览",
    "common.export": "导出",
    "common.close": "关闭",
  },
} as const;

export type TranslationKey = keyof typeof translations.en;

interface I18nContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: TranslationKey) => string;
}

const I18nContext = React.createContext<I18nContextValue>({
  lang: "en",
  setLang: () => {},
  t: (key) => key,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = React.useState<Lang>("en");

  React.useEffect(() => {
    try {
      const saved = localStorage.getItem("sciwrite-lang") as Lang | null;
      if (saved === "en" || saved === "zh") {
        setLangState(saved);
      }
    } catch {}
  }, []);

  const setLang = React.useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem("sciwrite-lang", l);
    } catch {}
  }, []);

  const t = React.useCallback(
    (key: TranslationKey) => {
      return (translations[lang] as Record<string, string>)[key] || key;
    },
    [lang]
  );

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return React.useContext(I18nContext);
}
