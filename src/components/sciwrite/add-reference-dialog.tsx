"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Plus,
  Loader2,
  Search,
  BookOpen,
  X,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { api } from "@/lib/api-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string | null;
}

interface LookupResult {
  type: string;
  externalId?: string;
  title: string;
  authors?: string;
  journal?: string;
  year?: string;
  url?: string;
  doi?: string;
  abstract?: string;
}

export function AddReferenceDialog({ open, onOpenChange, projectId }: Props) {
  const qc = useQueryClient();
  const [mode, setMode] = React.useState<"lookup" | "manual">("lookup");
  const [lookupType, setLookupType] = React.useState<"pmid" | "doi">("pmid");
  const [lookupId, setLookupId] = React.useState("");
  const [lookupResult, setLookupResult] = React.useState<LookupResult | null>(null);

  // Manual form fields
  const [manual, setManual] = React.useState({
    type: "manual",
    title: "",
    authors: "",
    journal: "",
    year: "",
    url: "",
    doi: "",
    abstract: "",
  });

  React.useEffect(() => {
    if (open) {
      setLookupId("");
      setLookupResult(null);
      setManual({
        type: "manual",
        title: "",
        authors: "",
        journal: "",
        year: "",
        url: "",
        doi: "",
        abstract: "",
      });
    }
  }, [open]);

  const lookupMut = useMutation({
    mutationFn: async () => {
      const id = lookupId.trim();
      if (!id) throw new Error("Please enter a PMID or DOI.");
      const res = await fetch(
        `/api/references/lookup?type=${lookupType}&id=${encodeURIComponent(id)}`
      );
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `Lookup failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: (data: LookupResult) => {
      setLookupResult(data);
      toast.success("Reference found.");
    },
    onError: (e: Error) => {
      setLookupResult(null);
      toast.error(e.message);
    },
  });

  const saveMut = useMutation({
    mutationFn: async (ref: Partial<LookupResult>) => {
      return api.createReference({
        type: (ref.type as any) || "manual",
        externalId: ref.externalId,
        title: ref.title || "",
        authors: ref.authors,
        journal: ref.journal,
        year: ref.year,
        url: ref.url,
        doi: ref.doi,
        abstract: ref.abstract,
        projectId: projectId || undefined,
      });
    },
    onSuccess: () => {
      toast.success("Reference added.");
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <BookOpen className="h-4 w-4 text-primary" />
            Add Reference
          </DialogTitle>
          <DialogDescription className="text-xs">
            Look up a reference by PMID/DOI, or enter it manually.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 p-0.5 rounded-md bg-muted/50">
          <button
            onClick={() => setMode("lookup")}
            className={`flex-1 text-xs py-1.5 rounded transition-colors ${
              mode === "lookup"
                ? "bg-card shadow-sm font-medium text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Search className="h-3 w-3 inline mr-1" />
            Lookup
          </button>
          <button
            onClick={() => setMode("manual")}
            className={`flex-1 text-xs py-1.5 rounded transition-colors ${
              mode === "manual"
                ? "bg-card shadow-sm font-medium text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Plus className="h-3 w-3 inline mr-1" />
            Manual
          </button>
        </div>

        {mode === "lookup" ? (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Select
                value={lookupType}
                onValueChange={(v) => setLookupType(v as any)}
              >
                <SelectTrigger className="w-24 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pmid" className="text-xs">PMID</SelectItem>
                  <SelectItem value="doi" className="text-xs">DOI</SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={lookupId}
                onChange={(e) => setLookupId(e.target.value)}
                placeholder={
                  lookupType === "pmid" ? "e.g. 25189619" : "e.g. 10.1038/nature"
                }
                className="flex-1 h-8 text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter") lookupMut.mutate();
                }}
              />
              <Button
                size="sm"
                className="h-8 px-2.5"
                onClick={() => lookupMut.mutate()}
                disabled={lookupMut.isPending || !lookupId.trim()}
              >
                {lookupMut.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Search className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>

            {lookupResult && (
              <div className="rounded-lg border border-primary/30 bg-primary/[0.03] p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-primary font-semibold">
                    Found
                  </span>
                  <button
                    onClick={() => setLookupResult(null)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <p className="text-xs font-medium leading-snug">
                  {lookupResult.title}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {lookupResult.authors}
                  {lookupResult.year ? ` (${lookupResult.year})` : ""}
                  {lookupResult.journal ? ` · ${lookupResult.journal}` : ""}
                </p>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="badge-emerald px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase">
                    {lookupResult.type}
                    {lookupResult.externalId ? `:${lookupResult.externalId}` : ""}
                  </span>
                  {lookupResult.doi && (
                    <span className="text-[9px] font-mono text-muted-foreground">
                      doi:{lookupResult.doi}
                    </span>
                  )}
                  {lookupResult.url && (
                    <a
                      href={lookupResult.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[9px] text-primary hover:underline inline-flex items-center gap-0.5"
                    >
                      <ExternalLink className="h-2.5 w-2.5" /> open
                    </a>
                  )}
                </div>
                <Button
                  size="sm"
                  className="w-full h-7 text-[11px] mt-2"
                  onClick={() => saveMut.mutate(lookupResult)}
                  disabled={saveMut.isPending}
                >
                  {saveMut.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Plus className="h-3 w-3" />
                  )}
                  Add this reference
                </Button>
              </div>
            )}
            {!lookupResult && !lookupMut.isPending && (
              <p className="text-[10px] text-muted-foreground text-center py-2">
                Enter a PMID (PubMed ID) or DOI to look up a reference automatically.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2.5 max-h-[50vh] overflow-y-auto scroll-academic pr-1">
            <div className="space-y-1">
              <Label className="text-xs">Title *</Label>
              <Input
                value={manual.title}
                onChange={(e) => setManual({ ...manual, title: e.target.value })}
                placeholder="Article title"
                className="text-xs h-8"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Authors</Label>
                <Input
                  value={manual.authors}
                  onChange={(e) =>
                    setManual({ ...manual, authors: e.target.value })
                  }
                  placeholder="Smith J, Doe A"
                  className="text-xs h-8"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Year</Label>
                <Input
                  value={manual.year}
                  onChange={(e) => setManual({ ...manual, year: e.target.value })}
                  placeholder="2024"
                  className="text-xs h-8"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Journal</Label>
                <Input
                  value={manual.journal}
                  onChange={(e) =>
                    setManual({ ...manual, journal: e.target.value })
                  }
                  placeholder="Nature"
                  className="text-xs h-8"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">DOI</Label>
                <Input
                  value={manual.doi}
                  onChange={(e) => setManual({ ...manual, doi: e.target.value })}
                  placeholder="10.1038/..."
                  className="text-xs h-8"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">URL</Label>
              <Input
                value={manual.url}
                onChange={(e) => setManual({ ...manual, url: e.target.value })}
                placeholder="https://..."
                className="text-xs h-8"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Abstract / notes</Label>
              <Textarea
                value={manual.abstract}
                onChange={(e) =>
                  setManual({ ...manual, abstract: e.target.value })
                }
                placeholder="Brief abstract or notes…"
                className="text-xs min-h-[48px]"
              />
            </div>
          </div>
        )}

        {mode === "manual" && (
          <DialogFooter>
            <Button
              onClick={() => saveMut.mutate(manual)}
              disabled={saveMut.isPending || !manual.title.trim()}
              className="gap-1.5"
            >
              {saveMut.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Add reference
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
