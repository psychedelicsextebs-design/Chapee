"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ListTodo,
  Plus,
  CalendarClock,
  CheckCircle2,
  Loader2,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { TaskApi } from "@/lib/tasks";
import {
  TaskEditorDialog,
  type StaffOption,
} from "@/components/TaskEditorDialog";
import {
  dispatchTasksChanged,
  subscribeTasksChanged,
} from "@/lib/tasks-events";

type Props = {
  conversationId: string;
  buyerId: string | null;
  country: string | null;
};

function formatDueShort(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isOverdue(iso: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  return !isNaN(d.getTime()) && d.getTime() < Date.now();
}

/**
 * チャット画面の左サイドバーに表示するタスクパネル。
 * - 現在の会話に紐づくタスクを一覧
 * - 「＋」で追加ダイアログを開く（conversation_id / buyer_id / country を自動セット）
 */
export function ChatSidebarTasksPanel({ conversationId, buyerId, country }: Props) {
  const [tasks, setTasks] = useState<TaskApi[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);

  const loadTasks = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/tasks/by-conversation/${encodeURIComponent(conversationId)}`
      );
      if (!res.ok) throw new Error();
      const data = await res.json();
      setTasks((data.tasks || []) as TaskApi[]);
    } catch {
      // サイドバー内のエラーは toast ではなく静かに握る（画面を塞がないため）
    }
  }, [conversationId]);

  const loadStaff = useCallback(async () => {
    try {
      const res = await fetch("/api/staff");
      if (!res.ok) return;
      const data = await res.json();
      setStaff((data.staff || []) as StaffOption[]);
    } catch {
      // 無音
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([loadTasks(), loadStaff()]);
      setLoading(false);
    })();
  }, [loadTasks, loadStaff]);

  // 他の画面でタスクが変化したら再取得
  useEffect(() => {
    return subscribeTasksChanged(() => {
      void loadTasks();
    });
  }, [loadTasks]);

  const pendingTasks = useMemo(
    () => tasks.filter((t) => !t.completed),
    [tasks]
  );
  const doneCount = tasks.length - pendingTasks.length;

  const staffById = useMemo(() => {
    const m = new Map<string, StaffOption>();
    for (const s of staff) m.set(s.id, s);
    return m;
  }, [staff]);

  const handleSaved = (saved: TaskApi) => {
    setTasks((prev) => {
      const exists = prev.some((t) => t.id === saved.id);
      return exists ? prev.map((t) => (t.id === saved.id ? saved : t)) : [saved, ...prev];
    });
  };

  const toggleComplete = async (t: TaskApi) => {
    try {
      const res = await fetch(`/api/tasks/${t.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: !t.completed }),
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { task: TaskApi };
      setTasks((prev) => prev.map((x) => (x.id === t.id ? data.task : x)));
      toast.success(data.task.completed ? "タスクを完了しました" : "タスクを未完了に戻しました");
      dispatchTasksChanged();
    } catch {
      toast.error("更新に失敗しました");
    }
  };

  return (
    <div className="bg-card rounded-xl border border-border shadow-card p-4 space-y-2">
      <div className="flex items-center justify-between pb-1 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <ListTodo size={14} className="text-primary shrink-0" />
          <p className="text-foreground font-semibold text-sm">
            タスク
            <span className="ml-1 text-xs text-muted-foreground">
              （未完了 {pendingTasks.length}
              {doneCount > 0 ? ` / 完了 ${doneCount}` : ""}）
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditorOpen(true)}
          className="p-1 rounded-md hover:bg-primary-subtle text-primary transition-colors"
          aria-label="タスクを追加"
          title="タスクを追加"
        >
          <Plus size={16} />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-xs py-2">
          <Loader2 size={14} className="animate-spin" />
          読み込み中…
        </div>
      ) : pendingTasks.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">
          {tasks.length === 0
            ? "タスクがありません"
            : "未完了のタスクはありません"}
        </p>
      ) : (
        <ul className="space-y-1.5 max-h-[min(40vh,280px)] overflow-y-auto scrollbar-thin">
          {pendingTasks.map((t) => {
            const overdue = isOverdue(t.due_date);
            const assigneeRows = t.assignees
              .map((id) => staffById.get(id))
              .filter((v): v is StaffOption => Boolean(v));
            return (
              <li
                key={t.id}
                className="rounded-lg border border-border bg-muted/30 px-2.5 py-2 text-xs space-y-1.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-foreground line-clamp-2 min-w-0 flex-1">
                    {t.title}
                  </p>
                  <div className="flex -space-x-1 shrink-0">
                    {assigneeRows.length === 0 ? (
                      <div className="w-5 h-5 rounded-full bg-gray-100 border border-white flex items-center justify-center text-[9px] text-gray-400">
                        —
                      </div>
                    ) : (
                      assigneeRows.slice(0, 3).map((s) => (
                        <div
                          key={s.id}
                          title={s.name}
                          className="w-5 h-5 rounded-full gradient-primary border border-white flex items-center justify-center"
                        >
                          <span className="text-primary-foreground font-bold text-[9px]">
                            {s.name[0]}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
                {t.content && (
                  <p className="text-muted-foreground whitespace-pre-wrap line-clamp-3 text-[11px]">
                    {t.content}
                  </p>
                )}
                <div className="flex items-center justify-between gap-2">
                  {t.due_date ? (
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 text-[11px]",
                        overdue ? "text-red-600 font-medium" : "text-muted-foreground"
                      )}
                    >
                      <CalendarClock size={11} />
                      {formatDueShort(t.due_date)}
                      {overdue && "（超過）"}
                    </span>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">期限なし</span>
                  )}
                  <button
                    type="button"
                    onClick={() => toggleComplete(t)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md gradient-primary text-primary-foreground text-[11px] font-medium shadow-sm hover:opacity-90 transition-opacity"
                    aria-label="完了"
                    title="完了にする"
                  >
                    <CheckCircle2 size={11} />
                    完了
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="pt-1 border-t border-border">
        <Link
          href="/tasks"
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors"
        >
          <ExternalLink size={11} />
          タスク管理を開く
        </Link>
      </div>

      <TaskEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        task={null}
        staff={staff}
        defaultTitle="要確認"
        autoConversationId={conversationId}
        autoBuyerId={buyerId}
        autoCountry={country}
        onSaved={handleSaved}
      />
    </div>
  );
}
