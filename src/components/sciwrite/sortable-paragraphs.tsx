"use client";

import * as React from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { api } from "@/lib/api-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ParagraphCard } from "./paragraph-card";
import { useI18n } from "@/lib/i18n";
import type { Annotation, Paragraph } from "@/lib/types";

interface Props {
  paragraphs: (Paragraph & { annotations: Annotation[]; references: any[] })[];
  projectId: string;
}

export function SortableParagraphs({ paragraphs, projectId }: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [items, setItems] = React.useState(paragraphs.map((p) => p.id));

  // Sync local order when paragraphs change (e.g. new paragraph added)
  React.useEffect(() => {
    const currentIds = paragraphs.map((p) => p.id);
    // only re-sync if the set of ids changed, not just order
    const sameSet =
      currentIds.length === items.length &&
      currentIds.every((id) => items.includes(id));
    if (!sameSet) {
      setItems(currentIds);
    }
  }, [paragraphs]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const reorderMut = useMutation({
    mutationFn: async (updates: { id: string; order: number }[]) => {
      const results = [];
      for (const u of updates) {
        results.push(api.updateParagraph(u.id, { order: u.order }));
      }
      return Promise.all(results);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.indexOf(active.id as string);
    const newIndex = items.indexOf(over.id as string);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(items, oldIndex, newIndex);
    setItems(next);
    // persist new order
    const updates = next.map((id, order) => ({ id, order }));
    reorderMut.mutate(updates);
    toast.success(t("toast.paragraphOrderUpdated"));
  };

  const orderedParagraphs = items
    .map((id) => paragraphs.find((p) => p.id === id))
    .filter(Boolean) as typeof paragraphs;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <div className="space-y-3">
          {orderedParagraphs.map((p, i) => (
            <SortableParagraph
              key={p.id}
              paragraph={p}
              projectId={projectId}
              index={i}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableParagraph({
  paragraph,
  projectId,
  index,
}: {
  paragraph: Paragraph & { annotations: Annotation[]; references: any[] };
  projectId: string;
  index: number;
}) {
  const { t } = useI18n();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: paragraph.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="relative group">
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="absolute -left-6 top-4 h-8 w-5 flex items-center justify-center cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity text-muted-foreground hover:text-primary touch-none"
        aria-label={t("sortable.dragReorder")}
        title={t("sortable.dragReorder")}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <ParagraphCard paragraph={paragraph} projectId={projectId} index={index} />
    </div>
  );
}
