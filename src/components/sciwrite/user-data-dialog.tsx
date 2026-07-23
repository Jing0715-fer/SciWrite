"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  DatabaseZap,
  Loader2,
  Plus,
  Trash2,
  Image as ImageIcon,
  Table,
  FileText,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string | null;
}

const TYPE_META: Record<string, { label: string; icon: any; color: string }> = {
  image: { label: "Image", icon: ImageIcon, color: "badge-violet" },
  table: { label: "Table", icon: Table, color: "badge-amber" },
  text: { label: "Text", icon: FileText, color: "badge-sky" },
};

export function UserDataDialog({ open, onOpenChange, projectId }: Props) {
  const qc = useQueryClient();
  const [type, setType] = React.useState<"image" | "table" | "text">("text");
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [tableHeaders, setTableHeaders] = React.useState("");
  const [tableRows, setTableRows] = React.useState("");

  const userDataQ = useQuery({
    queryKey: ["user-data", projectId],
    queryFn: () => fetch(`/api/user-data?projectId=${projectId}`).then((r) => r.json()),
    enabled: open && !!projectId,
  });

  const createMut = useMutation({
    mutationFn: async () => {
      const data: any = {};
      if (type === "table") {
        const headers = tableHeaders.split(/[\t,]/).map((h) => h.trim()).filter(Boolean);
        const rows = tableRows
          .split("\n")
          .map((line) => line.split(/[\t,]/).map((c) => c.trim()))
          .filter((r) => r.some((c) => c));
        data.headers = headers;
        data.rows = rows;
      }
      return fetch("/api/user-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          type,
          title: title || `${type} data`,
          description: description || undefined,
          data: type === "table" ? JSON.stringify(data) : undefined,
        }),
      }).then((r) => r.json());
    },
    onSuccess: () => {
      toast.success("Data saved.");
      setTitle("");
      setDescription("");
      setTableHeaders("");
      setTableRows("");
      qc.invalidateQueries({ queryKey: ["user-data", projectId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/user-data/${id}`, { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => {
      toast.success("Data removed.");
      qc.invalidateQueries({ queryKey: ["user-data", projectId] });
    },
  });

  const items = userDataQ.data?.userData || [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/60 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <DatabaseZap className="h-4 w-4 text-primary" />
            Experiment Data
          </DialogTitle>
          <DialogDescription className="text-xs">
            Upload images, tables, or text descriptions to use in AI writing (Results sections).
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0 scroll-academic">
          <div className="px-6 py-4 space-y-4">
            {/* Add form */}
            <div className="rounded-lg border border-border/60 p-3 space-y-3">
              <p className="text-[10px] uppercase tracking-wider text-primary font-semibold">
                Add new data
              </p>
              <div className="grid grid-cols-3 gap-1">
                {(["text", "table", "image"] as const).map((t) => {
                  const meta = TYPE_META[t];
                  const Icon = meta.icon;
                  return (
                    <button
                      key={t}
                      onClick={() => setType(t)}
                      className={`flex flex-col items-center gap-1 py-2 rounded-md border transition-colors text-[10px] ${
                        type === t
                          ? "border-primary bg-primary/5 text-primary font-medium"
                          : "border-border text-muted-foreground hover:bg-muted/40"
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      {meta.label}
                    </button>
                  );
                })}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Title</Label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={type === "image" ? "e.g. Figure 1: TMC1 cryo-EM map" : type === "table" ? "e.g. Table 1: TMC domain comparison" : "e.g. Observation notes"}
                  className="text-xs h-8"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Description / caption</Label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={type === "image" ? "Describe the figure content and key findings..." : type === "table" ? "Describe what the table shows..." : "Enter your text description, observation, or data summary..."}
                  className="text-xs min-h-[60px]"
                />
              </div>
              {type === "table" && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Table headers (comma or tab separated)</Label>
                  <Input
                    value={tableHeaders}
                    onChange={(e) => setTableHeaders(e.target.value)}
                    placeholder="Domain, Length, Resolution, Method"
                    className="text-xs h-8 font-mono"
                  />
                  <Label className="text-xs mt-2">Table rows (one per line, comma or tab separated)</Label>
                  <Textarea
                    value={tableRows}
                    onChange={(e) => setTableRows(e.target.value)}
                    placeholder={"N-terminal, 200aa, 3.2Å, cryo-EM\nC-terminal, 150aa, 2.8Å, X-ray"}
                    className="text-xs min-h-[80px] font-mono"
                  />
                </div>
              )}
              {type === "image" && (
                <p className="text-[10px] text-muted-foreground italic">
                  Image upload via file path — provide the image description/caption above. The AI will use it as context for Results writing.
                </p>
              )}
              <Button
                size="sm"
                className="w-full h-8 text-xs gap-1.5"
                onClick={() => createMut.mutate()}
                disabled={createMut.isPending || (!title.trim() && !description.trim())}
              >
                {createMut.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                Save data
              </Button>
            </div>

            {/* Existing data list */}
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Saved data ({items.length})
              </p>
              {items.length === 0 && (
                <p className="text-[11px] text-muted-foreground text-center py-6">
                  No experiment data saved yet.
                </p>
              )}
              {items.map((item: any) => {
                const meta = TYPE_META[item.type] || TYPE_META.text;
                const Icon = meta.icon;
                return (
                  <div
                    key={item.id}
                    className="rounded-md border border-border/60 p-2.5 space-y-1"
                  >
                    <div className="flex items-center gap-1.5">
                      <Icon className="h-3 w-3 text-muted-foreground" />
                      <span className={`px-1 py-0.5 rounded text-[8px] font-semibold uppercase ${meta.color}`}>
                        {item.type}
                      </span>
                      <p className="text-[11px] font-medium flex-1 truncate">{item.title}</p>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 text-destructive"
                        onClick={() => deleteMut.mutate(item.id)}
                      >
                        <Trash2 className="h-2.5 w-2.5" />
                      </Button>
                    </div>
                    {item.description && (
                      <p className="text-[10px] text-muted-foreground leading-relaxed">
                        {item.description}
                      </p>
                    )}
                    {item.data && (
                      <p className="text-[9px] text-muted-foreground/70 font-mono">
                        {(() => {
                          try {
                            const td = JSON.parse(item.data);
                            return td.headers ? `Table: ${td.headers.length} cols × ${td.rows?.length || 0} rows` : "structured data";
                          } catch {
                            return "data";
                          }
                        })()}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
