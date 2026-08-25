"use client";

import * as React from "react";
import { toast } from "sonner";
import { Share2, Copy, Loader2, X, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { api } from "@/lib/api-client";
import { useMutation } from "@tanstack/react-query";
import { useI18n } from "@/lib/i18n";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  projectTitle: string;
}

/**
 * Share Dialog
 *
 * Generates a read-only share link for the project. Anyone with the link
 * can view the project's articles (but not edit them). The link can be
 * revoked at any time.
 */
export function ShareDialog({ open, onOpenChange, projectId, projectTitle }: Props) {
  const { t } = useI18n();
  const [token, setToken] = React.useState<string | null>(null);

  const shareMut = useMutation({
    mutationFn: (action: "create" | "revoke") => api.shareProject(projectId, action),
    onSuccess: (data) => {
      setToken(data.shareToken);
      if (data.shareToken) {
        toast.success(t("share.linkCreated") || "Share link created");
      } else {
        toast.success(t("share.linkRevoked") || "Share link revoked");
      }
    },
    onError: (e: any) => toast.error(e?.message || "Failed to manage share link"),
  });

  // Load existing token when dialog opens
  React.useEffect(() => {
    if (open) {
      shareMut.mutate("create");
    }
  }, [open, projectId]);

  const shareUrl = token ? `${window.location.origin}/shared/${token}` : "";

  const copyLink = () => {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl).then(() => {
      toast.success(t("share.copied") || "Link copied to clipboard");
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-xl overflow-hidden">
        <DialogHeader className="bg-gradient-to-r from-primary/5 to-transparent border-b border-border/60 px-6 pt-5 pb-3 -mx-6 -mt-6 mb-2">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <div className="flex items-center justify-center h-7 w-7 rounded-md bg-primary/10 text-primary">
              <Share2 className="h-4 w-4" />
            </div>
            {t("share.title") || "Share Project"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t("share.desc") || "Generate a read-only link. Anyone with the link can view the project's articles but cannot edit them."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {shareMut.isPending && !token && (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {token && (
            <>
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  {t("share.linkLabel") || "Share link"}
                </p>
                <div className="flex items-center gap-2 p-1 rounded-lg bg-muted/40 border border-border/40">
                  <input
                    type="text"
                    value={shareUrl}
                    readOnly
                    className="flex-1 h-8 text-[10px] font-mono bg-transparent border-none px-2 focus:outline-none truncate"
                  />
                  <Button
                    variant="default"
                    size="sm"
                    className="h-8 px-3 shrink-0 gap-1 transition-all hover:shadow-sm"
                    onClick={copyLink}
                  >
                    <Copy className="h-3 w-3" />
                    <span className="text-[10px]">{t("share.copy") || "Copy"}</span>
                  </Button>
                </div>
                <p className="text-[9px] text-muted-foreground">
                  {t("share.note") || "This link provides read-only access. The link remains valid until revoked."}
                </p>
              </div>

              <div className="flex items-center justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-[10px] h-7 gap-1 text-muted-foreground"
                  onClick={() => window.open(shareUrl, "_blank")}
                >
                  <ExternalLink className="h-3 w-3" />
                  {t("share.openLink") || "Open link"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-[10px] h-7 gap-1 border-red-300/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                  onClick={() => shareMut.mutate("revoke")}
                  disabled={shareMut.isPending}
                >
                  <X className="h-3 w-3" />
                  {t("share.revoke") || "Revoke link"}
                </Button>
              </div>
            </>
          )}

          {!shareMut.isPending && !token && (
            <div className="text-center py-4">
              <p className="text-xs text-muted-foreground mb-3">
                {t("share.noLink") || "No active share link."}
              </p>
              <Button
                variant="default"
                size="sm"
                className="gap-1.5"
                onClick={() => shareMut.mutate("create")}
              >
                <Share2 className="h-3.5 w-3.5" />
                {t("share.create") || "Create share link"}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
