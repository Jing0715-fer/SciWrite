"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  MessageSquare,
  Send,
  Loader2,
  Check,
  RotateCcw,
  Trash2,
  CornerDownRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api-client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useI18n } from "@/lib/i18n";

interface Props {
  articleId: string;
}

/**
 * Comments Panel
 *
 * Displays threaded comments for an article. Users can:
 *  - Add a top-level comment
 *  - Reply to an existing comment (threaded via parentId)
 *  - Resolve/unresolve a comment (toggle)
 *  - Delete a comment (also deletes its replies)
 *
 * Resolved comments are shown with a strikethrough + green check.
 * The panel auto-refreshes when comments change (React Query invalidation).
 */
export function CommentsPanel({ articleId }: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [newComment, setNewComment] = React.useState("");
  const [replyingTo, setReplyingTo] = React.useState<string | null>(null);
  const [replyContent, setReplyContent] = React.useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["comments", articleId],
    queryFn: () => api.listComments({ articleId }),
  });

  const comments = data?.comments || [];

  // Build threaded structure: top-level comments + their replies
  const topLevel = comments.filter((c) => !c.parentId);
  const repliesByParent = new Map<string, typeof comments>();
  for (const c of comments) {
    if (c.parentId) {
      if (!repliesByParent.has(c.parentId)) repliesByParent.set(c.parentId, []);
      repliesByParent.get(c.parentId)!.push(c);
    }
  }

  const createMut = useMutation({
    mutationFn: (input: { content: string; parentId?: string }) =>
      api.createComment({ articleId, content: input.content, parentId: input.parentId }),
    onSuccess: () => {
      setNewComment("");
      setReplyingTo(null);
      setReplyContent("");
      qc.invalidateQueries({ queryKey: ["comments", articleId] });
    },
    onError: (e: any) => toast.error(e?.message || "Failed to add comment"),
  });

  const resolveMut = useMutation({
    mutationFn: ({ id, resolved }: { id: string; resolved: boolean }) =>
      api.updateComment(id, { resolved: !resolved }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["comments", articleId] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteComment(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["comments", articleId] });
    },
  });

  const handleAddComment = () => {
    if (!newComment.trim()) return;
    createMut.mutate({ content: newComment.trim() });
  };

  const handleReply = (parentId: string) => {
    if (!replyContent.trim()) return;
    createMut.mutate({ content: replyContent.trim(), parentId });
  };

  const resolvedCount = comments.filter((c) => c.resolved).length;

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          {t("comments.title") || "Comments"} ({comments.length})
        </span>
        {resolvedCount > 0 && (
          <Badge variant="outline" className="text-[8px] h-3.5 gap-0.5 text-emerald-600 border-emerald-300/40">
            <Check className="h-2.5 w-2.5" />
            {resolvedCount} {t("comments.resolved") || "resolved"}
          </Badge>
        )}
      </div>

      {/* New comment input */}
      <div className="flex items-end gap-2">
        <Textarea
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          placeholder={t("comments.placeholder") || "Add a comment…"}
          className="text-[11px] min-h-[40px] resize-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              handleAddComment();
            }
          }}
        />
        <Button
          variant="default"
          size="sm"
          className="h-8 px-2 shrink-0"
          onClick={handleAddComment}
          disabled={!newComment.trim() || createMut.isPending}
        >
          {createMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {/* Comment list */}
      <ScrollArea className="max-h-[300px]">
        <div className="space-y-2 pr-2">
          {isLoading && (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}

          {!isLoading && topLevel.length === 0 && (
            <p className="text-[10px] text-muted-foreground text-center py-4">
              {t("comments.empty") || "No comments yet."}
            </p>
          )}

          {topLevel.map((comment) => {
            const replies = repliesByParent.get(comment.id) || [];
            return (
              <div key={comment.id} className="space-y-1.5">
                {/* Top-level comment */}
                <CommentCard
                  comment={comment}
                  onResolve={() => resolveMut.mutate({ id: comment.id, resolved: comment.resolved })}
                  onDelete={() => deleteMut.mutate(comment.id)}
                  onReply={() => {
                    setReplyingTo(replyingTo === comment.id ? null : comment.id);
                    setReplyContent("");
                  }}
                  isReplying={replyingTo === comment.id}
                />

                {/* Reply input */}
                {replyingTo === comment.id && (
                  <div className="flex items-end gap-2 pl-6">
                    <Textarea
                      value={replyContent}
                      onChange={(e) => setReplyContent(e.target.value)}
                      placeholder={t("comments.replyPlaceholder") || "Reply…"}
                      className="text-[10px] min-h-[32px] resize-none"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          handleReply(comment.id);
                        }
                      }}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 shrink-0 text-[10px] gap-1"
                      onClick={() => handleReply(comment.id)}
                      disabled={!replyContent.trim() || createMut.isPending}
                    >
                      <CornerDownRight className="h-3 w-3" />
                      {t("comments.reply") || "Reply"}
                    </Button>
                  </div>
                )}

                {/* Replies */}
                {replies.map((reply) => (
                  <div key={reply.id} className="pl-6">
                    <CommentCard
                      comment={reply}
                      isReply
                      onResolve={() => resolveMut.mutate({ id: reply.id, resolved: reply.resolved })}
                      onDelete={() => deleteMut.mutate(reply.id)}
                    />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

/** Single comment card with resolve/delete/reply actions */
function CommentCard({
  comment,
  isReply,
  onResolve,
  onDelete,
  onReply,
  isReplying,
}: {
  comment: any;
  isReply?: boolean;
  onResolve: () => void;
  onDelete: () => void;
  onReply?: () => void;
  isReplying?: boolean;
}) {
  const { t } = useI18n();
  const time = new Date(comment.createdAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" });

  return (
    <div
      className={`rounded-lg border p-2.5 space-y-1 transition-all hover:shadow-sm ${
        comment.resolved
          ? "border-emerald-300/40 bg-gradient-to-br from-emerald-50/40 to-emerald-50/10 dark:from-emerald-950/15 dark:to-emerald-950/5"
          : "border-border/50 bg-gradient-to-br from-muted/20 to-transparent hover:border-primary/30"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-medium text-foreground">{comment.author}</span>
        <span className="text-[8px] text-muted-foreground">{time}</span>
        {comment.resolved && (
          <Badge variant="outline" className="text-[7px] h-3 px-1 text-emerald-600 border-emerald-300/40">
            <Check className="h-2 w-2" />
          </Badge>
        )}
        <div className="flex-1" />
        {!isReply && (
          <Button
            variant="ghost"
            size="sm"
            className="h-4 px-1 text-[8px] text-muted-foreground hover:text-foreground"
            onClick={onReply}
          >
            <CornerDownRight className="h-2.5 w-2.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-4 px-1 text-[8px] text-muted-foreground hover:text-foreground"
          onClick={onResolve}
          title={comment.resolved ? (t("comments.unresolve") || "Unresolve") : (t("comments.resolve") || "Resolve")}
        >
          {comment.resolved ? <RotateCcw className="h-2.5 w-2.5" /> : <Check className="h-2.5 w-2.5" />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-4 px-1 text-[8px] text-red-600 hover:text-red-700"
          onClick={onDelete}
        >
          <Trash2 className="h-2.5 w-2.5" />
        </Button>
      </div>
      <p className={`text-[10px] leading-relaxed ${comment.resolved ? "line-through text-muted-foreground/60" : "text-foreground"}`}>
        {comment.content}
      </p>
    </div>
  );
}
