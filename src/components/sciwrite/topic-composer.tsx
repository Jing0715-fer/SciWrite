"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Sparkles,
  Loader2,
  Wand2,
  X,
  BookOpen,
  Database as DatabaseIcon,
  Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api-client";
import {
  PARAGRAPH_FORMATS,
  PARAGRAPH_SCENARIOS,
} from "@/lib/constants";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MarkdownCitations } from "./markdown-citations";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  projectTopic: string;
  projectField?: string | null;
  references: { id: string; title: string; type: string; externalId?: string | null }[];
  dataSources: { id: string; source: string; title: string | null; query: string }[];
}

export function TopicComposer({
  open,
  onOpenChange,
  projectId,
  projectTopic,
  projectField,
  references,
  dataSources,
}: Props) {
  const [topic, setTopic] = React.useState(projectTopic || "");
  const [focus, setFocus] = React.useState("");
  const [format, setFormat] = React.useState<string>("background");
  const [scenario, setScenario] = React.useState<string>("literature-review");
  const [selectedRefs, setSelectedRefs] = React.useState<string[]>([]);
  const [selectedSources, setSelectedSources] = React.useState<string[]>([]);
  const [searchQ, setSearchQ] = React.useState("");
  const [generated, setGenerated] = React.useState<string | null>(null);
  const [streamText, setStreamText] = React.useState("");
  const qc = useQueryClient();

  React.useEffect(() => {
    if (open) {
      setTopic(projectTopic || "");
      setGenerated(null);
      setStreamText("");
    }
  }, [open, projectTopic]);

  // streaming-style reveal of generated content
  React.useEffect(() => {
    if (!generated) return;
    let i = 0;
    setStreamText("");
    const chunk = Math.max(2, Math.floor(generated.length / 220));
    const id = setInterval(() => {
      i += chunk;
      setStreamText(generated.slice(0, i));
      if (i >= generated.length) clearInterval(id);
    }, 14);
    return () => clearInterval(id);
  }, [generated]);

  const writeMut = useMutation({
    mutationFn: async () => {
      const searchQueries = searchQ
        .split(/[\n;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      return api.aiWrite({
        topic,
        focus: focus || undefined,
        format: format as any,
        scenario: scenario as any,
        projectId,
        field: projectField || undefined,
        referenceIds: selectedRefs,
        dataSourceIds: selectedSources,
        searchQueries,
      });
    },
    onSuccess: (data) => {
      setGenerated(data.content);
      toast.success("Paragraph drafted with citations.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!generated) throw new Error("Nothing to save yet.");
      return api.createParagraph({
        projectId,
        title: focus ? focus.slice(0, 60) : topic.slice(0, 60),
        content: generated,
        format,
        scenario,
      });
    },
    onSuccess: () => {
      toast.success("Paragraph saved to workspace.");
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = (arr: string[], setArr: (v: string[]) => void, id: string) => {
    setArr(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[88vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            AI Research Writer
          </DialogTitle>
          <DialogDescription className="text-xs">
            Provide a topic and focus. The AI searches databases &amp; the web, then
            drafts a citation-backed scholarly paragraph.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 scroll-academic">
          <div className="px-6 py-4 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Research topic</Label>
              <Textarea
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g. Structural basis of CRISPR-Cas9 target recognition and off-target effects"
                className="text-sm min-h-[60px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Specific focus / angle (optional)</Label>
              <Input
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                placeholder="e.g. focus on PAM-dependent unwinding mechanism"
                className="text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Paragraph format</Label>
                <Select value={format} onValueChange={setFormat}>
                  <SelectTrigger className="text-xs h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PARAGRAPH_FORMATS.map((f) => (
                      <SelectItem key={f.id} value={f.id} className="text-xs">
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Scenario</Label>
                <Select value={scenario} onValueChange={setScenario}>
                  <SelectTrigger className="text-xs h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PARAGRAPH_SCENARIOS.map((s) => (
                      <SelectItem key={s.id} value={s.id} className="text-xs">
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Sources selectors */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1.5">
                  <DatabaseIcon className="h-3 w-3" /> Data sources ({selectedSources.length})
                </Label>
                <div className="rounded-md border border-border/60 max-h-32 overflow-y-auto scroll-academic divide-y divide-border/40">
                  {dataSources.length === 0 && (
                    <p className="text-[10px] text-muted-foreground p-2">
                      No saved data sources yet. Query a database first.
                    </p>
                  )}
                  {dataSources.map((d) => (
                    <label
                      key={d.id}
                      className="flex items-start gap-2 p-2 hover:bg-muted/40 cursor-pointer"
                    >
                      <Checkbox
                        checked={selectedSources.includes(d.id)}
                        onCheckedChange={() =>
                          toggle(selectedSources, setSelectedSources, d.id)
                        }
                        className="mt-0.5"
                      />
                      <div className="min-w-0">
                        <p className="text-[11px] font-medium truncate">
                          {d.title || d.query}
                        </p>
                        <p className="text-[9px] text-muted-foreground uppercase">
                          {d.source}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1.5">
                  <BookOpen className="h-3 w-3" /> References ({selectedRefs.length})
                </Label>
                <div className="rounded-md border border-border/60 max-h-32 overflow-y-auto scroll-academic divide-y divide-border/40">
                  {references.length === 0 && (
                    <p className="text-[10px] text-muted-foreground p-2">
                      No references yet. Save some from the database panel.
                    </p>
                  )}
                  {references.map((r) => (
                    <label
                      key={r.id}
                      className="flex items-start gap-2 p-2 hover:bg-muted/40 cursor-pointer"
                    >
                      <Checkbox
                        checked={selectedRefs.includes(r.id)}
                        onCheckedChange={() =>
                          toggle(selectedRefs, setSelectedRefs, r.id)
                        }
                        className="mt-0.5"
                      />
                      <div className="min-w-0">
                        <p className="text-[11px] font-medium line-clamp-2">
                          {r.title}
                        </p>
                        <p className="text-[9px] text-muted-foreground">
                          {r.type}
                          {r.externalId ? `:${r.externalId}` : ""}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs flex items-center gap-1.5">
                <Globe className="h-3 w-3" /> Live web search queries (optional, one per line)
              </Label>
              <Textarea
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder={"recent CRISPR off-target reviews 2024\nCas9 PAM specificity mechanisms"}
                className="text-xs min-h-[48px] font-mono"
              />
            </div>

            {generated && (
              <div className="rounded-lg border border-primary/30 bg-primary/[0.02] p-4 acad-fade-in">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] uppercase tracking-wider text-primary font-semibold flex items-center gap-1">
                    <Wand2 className="h-3 w-3" /> Generated draft
                  </span>
                  <button
                    onClick={() => {
                      setGenerated(null);
                      setStreamText("");
                    }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <MarkdownCitations
                  content={streamText}
                  className="text-[13px]"
                />
                {streamText.length < generated.length && (
                  <span className="typing-caret" />
                )}
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="px-6 py-3 border-t border-border/60 gap-2">
          {!generated ? (
            <Button
              onClick={() => writeMut.mutate()}
              disabled={writeMut.isPending || !topic.trim()}
              className="gap-2"
            >
              {writeMut.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {writeMut.isPending ? "Researching & writing…" : "Generate paragraph"}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => writeMut.mutate()}
                disabled={writeMut.isPending}
                className="gap-2"
              >
                <Sparkles className="h-4 w-4" />
                Regenerate
              </Button>
              <Button
                onClick={() => saveMut.mutate()}
                disabled={saveMut.isPending}
                className="gap-2"
              >
                {saveMut.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Save to workspace
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
