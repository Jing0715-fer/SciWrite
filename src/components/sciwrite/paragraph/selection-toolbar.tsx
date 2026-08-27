"use client";

import * as React from "react";
import { toast } from "sonner";
import { MessageSquare, Copy, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ANNOTATION_TYPES } from "@/lib/constants";
import { useI18n } from "@/lib/i18n";

export function SelectionToolbar({
  text,
  onSubmit,
  onClose,
  pending,
}: {
  text: string;
  onSubmit: (comment: string, type: string, severity: string) => void;
  onClose: () => void;
  pending: boolean;
}) {
  const { t } = useI18n();
  const [comment, setComment] = React.useState("");
  const [type, setType] = React.useState("revise-request");
  const [severity, setSeverity] = React.useState("warning");

  return (
    <Popover open={true} onOpenChange={(o) => !o && onClose()}>
      <PopoverTrigger asChild>
        <span
          className="absolute"
          style={{
            left: 0,
            top: 0,
            width: 1,
            height: 1,
          }}
        />
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-3 shadow-lg"
        side="top"
        align="center"
        sideOffset={8}
      >
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-primary font-semibold flex items-center gap-1">
              <MessageSquare className="h-3 w-3" /> {t("para.annotateSelection")}
            </span>
            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={() => {
                  navigator.clipboard.writeText(text).then(() => toast.success(t("toast.copiedToClipboard")));
                  onClose();
                }}
                title={t("para.copySelectedText")}
              >
                <Copy className="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onClose}>
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>
          <p className="text-[10px] italic text-muted-foreground line-clamp-2 border-l-2 border-primary/40 pl-2">
            “{text.slice(0, 100)}{text.length > 100 ? "…" : ""}”
          </p>
          <Textarea
            autoFocus
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t("para.revisePlaceholder")}
            className="text-xs min-h-[56px]"
          />
          <div className="grid grid-cols-2 gap-1.5">
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="h-7 text-[10px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ANNOTATION_TYPES.map((t) => (
                  <SelectItem key={t.id} value={t.id} className="text-[10px]">
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={severity} onValueChange={setSeverity}>
              <SelectTrigger className="h-7 text-[10px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="info" className="text-[10px]">{t("para.info")}</SelectItem>
                <SelectItem value="warning" className="text-[10px]">{t("para.warning")}</SelectItem>
                <SelectItem value="critical" className="text-[10px]">{t("para.critical")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            className="w-full h-7 text-[11px]"
            disabled={!comment.trim() || pending}
            onClick={() => onSubmit(comment.trim(), type, severity)}
          >
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {t("para.addAnnotation2")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
