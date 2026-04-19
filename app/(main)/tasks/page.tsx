"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  CheckCircle2,
  ExternalLink,
  Loader2,
  CalendarClock,
  ListTodo,
  Users as UsersIcon,
  Flag,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { SHOPEE_MARKET_CODES } from "@/lib/shopee-markets";
import type { TaskApi } from "@/lib/tasks";
import { TaskEditorDialog, type StaffOption } from "@/components/TaskEditorDialog";
import {
  dispatchTasksChanged,
  subscribeTasksChanged,
} from "@/lib/tasks-events";

function formatDueDate(iso: string | null): string {
  if (!iso) return "期限なし";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "期限なし";
  return d.toLocaleString("ja-JP", {
    year: "numeric",
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

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskApi[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState<"pending" | "done">("pending");
  const [filterCountry, setFilterCountry] = useState<string>("all");
  const [filterAssignee, setFilterAssignee] = useState<string>("all");

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskApi | null>(null);

  const staffById = useMemo(() => {
    const m = new Map<string, StaffOption>();
    for (const s of staff) m.set(s.id, s);
    return m;
  }, [staff]);

  const loadTasks = useCallback(async () => {
    const res = await fetch("/api/tasks");
    if (!res.ok) throw new Error("load tasks failed");
    const data = await res.json();
    setTasks((data.tasks || []) as TaskApi[]);
  }, []);

  const loadStaff = useCallback(async () => {
    const res = await fetch("/api/staff");
    if (!res.ok) throw new Error("load staff failed");
    const data = await res.json();
    setStaff((data.staff || []) as StaffOption[]);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        await Promise.all([loadTasks(), loadStaff()]);
      } catch {
        toast.error("タスクの読み込みに失敗しました");
      } finally {
        setLoading(false);
      }
    })();
  }, [loadTasks, loadStaff]);

  // 他の画面でタスクが変わったら再取得
  useEffect(() => {
    return subscribeTasksChanged(() => {
      void loadTasks();
    });
  }, [loadTasks]);

  const visibleTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (tab === "pending" && t.completed) return false;
      if (tab === "done" && !t.completed) return false;
      if (filterCountry !== "all" && t.country !== filterCountry) return false;
      if (filterAssignee !== "all" && !t.assignees.includes(filterAssignee)) {
        return false;
      }
      return true;
    });
  }, [tasks, tab, filterCountry, filterAssignee]);

  const pendingCount = useMemo(() => tasks.filter((t) => !t.completed).length, [tasks]);
  const doneCount = useMemo(() => tasks.filter((t) => t.completed).length, [tasks]);

  const openCreate = () => {
    setEditingTask(null);
    setEditorOpen(true);
  };

  const openEdit = (t: TaskApi) => {
    setEditingTask(t);
    setEditorOpen(true);
  };

  const handleSaved = (saved: TaskApi) => {
    setTasks((prev) => {
      const exists = prev.some((t) => t.id === saved.id);
      return exists
        ? prev.map((t) => (t.id === saved.id ? saved : t))
        : [saved, ...prev];
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

  const deleteTask = async (id: string) => {
    if (!confirm("このタスクを削除しますか？")) return;
    try {
      const res = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setTasks((prev) => prev.filter((x) => x.id !== id));
      toast.success("削除しました");
      dispatchTasksChanged();
    } catch {
      toast.error("削除に失敗しました");
    }
  };

  return (
    <div className="space-y-5 animate-fade-in">
      {/* ヘッダー */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ListTodo size={22} className="text-primary" />
            <h1 className="text-2xl font-bold text-gray-900">タスク管理</h1>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            チームで共有するタスク一覧
          </p>
        </div>
        <Button
          className="gradient-primary text-primary-foreground shadow-green gap-1.5 w-full sm:w-auto min-h-[44px] sm:min-h-0"
          onClick={openCreate}
        >
          <Plus size={16} />
          タスク追加
        </Button>
      </div>

      {/* フィルター */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Select value={filterCountry} onValueChange={setFilterCountry}>
          <SelectTrigger className="bg-white">
            <div className="flex items-center gap-2">
              <Flag size={14} className="text-gray-400" />
              <SelectValue placeholder="国" />
            </div>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">すべての国</SelectItem>
            {SHOPEE_MARKET_CODES.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={tab} onValueChange={(v) => setTab(v as "pending" | "done")}>
          <SelectTrigger className="bg-white">
            <div className="flex items-center gap-2">
              <CheckCircle2 size={14} className="text-gray-400" />
              <SelectValue />
            </div>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pending">未完了（{pendingCount}）</SelectItem>
            <SelectItem value="done">完了（{doneCount}）</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterAssignee} onValueChange={setFilterAssignee}>
          <SelectTrigger className="bg-white">
            <div className="flex items-center gap-2">
              <UsersIcon size={14} className="text-gray-400" />
              <SelectValue placeholder="担当者" />
            </div>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全員</SelectItem>
            {staff.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* タブ（視覚的なタブ切替 / Select と同期） */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as "pending" | "done")}>
        <TabsList className="grid grid-cols-2 w-full sm:w-auto sm:inline-grid">
          <TabsTrigger value="pending">未完了（{pendingCount}）</TabsTrigger>
          <TabsTrigger value="done">完了（{doneCount}）</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* タスク一覧 */}
      {loading ? (
        <div className="py-16 text-center">
          <Loader2 className="animate-spin text-primary mx-auto mb-3" size={36} />
          <p className="text-gray-500 text-sm">読み込み中...</p>
        </div>
      ) : visibleTasks.length === 0 ? (
        <div className="py-16 text-center text-gray-500 text-sm bg-white rounded-2xl border border-gray-200">
          <ListTodo className="mx-auto mb-3 text-gray-300" size={36} />
          <p className="text-gray-900 font-medium">
            {tab === "pending" ? "未完了のタスクはありません" : "完了済みタスクはありません"}
          </p>
          <p className="text-xs mt-1 text-gray-500">
            右上の「タスク追加」から作成できます
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleTasks.map((t) => {
            const assigneeRows = t.assignees
              .map((id) => staffById.get(id))
              .filter((v): v is StaffOption => Boolean(v));
            const overdue = !t.completed && isOverdue(t.due_date);
            return (
              <div
                key={t.id}
                className={cn(
                  "bg-white rounded-2xl border shadow-sm p-4 sm:p-5",
                  t.completed ? "border-gray-200 opacity-80" : "border-gray-200"
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className={cn(
                      "font-bold text-base text-gray-900",
                      t.completed && "line-through text-gray-500"
                    )}>
                      {t.title}
                    </h3>
                    <div className="flex flex-wrap items-center gap-2 mt-1 text-xs text-gray-500">
                      {t.country && (
                        <span className="px-2 py-0.5 rounded-md bg-primary-subtle text-primary border border-primary/20 font-medium">
                          {t.country}
                        </span>
                      )}
                      <span className={cn(
                        "inline-flex items-center gap-1",
                        overdue && "text-red-600 font-medium"
                      )}>
                        <CalendarClock size={12} />
                        {formatDueDate(t.due_date)}
                        {overdue && "（期限超過）"}
                      </span>
                    </div>
                  </div>
                  <div className="flex -space-x-1 flex-shrink-0">
                    {assigneeRows.length === 0 ? (
                      <div className="w-8 h-8 rounded-full bg-gray-100 border-2 border-white flex items-center justify-center text-[10px] text-gray-400">
                        未割当
                      </div>
                    ) : (
                      assigneeRows.slice(0, 3).map((s) => (
                        <div
                          key={s.id}
                          title={s.name}
                          className="w-8 h-8 rounded-full gradient-primary border-2 border-white flex items-center justify-center"
                        >
                          <span className="text-primary-foreground font-bold text-xs">
                            {s.name[0]}
                          </span>
                        </div>
                      ))
                    )}
                    {assigneeRows.length > 3 && (
                      <div className="w-8 h-8 rounded-full bg-gray-200 border-2 border-white flex items-center justify-center text-[10px] text-gray-600">
                        +{assigneeRows.length - 3}
                      </div>
                    )}
                  </div>
                </div>

                {t.content && (
                  <div className="mt-3 rounded-xl bg-gray-50 border border-gray-200 p-3 text-sm text-gray-800 whitespace-pre-wrap">
                    {t.content}
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {t.conversation_id && (
                      <Link
                        href={`/chats/${t.conversation_id}`}
                        className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-primary transition-colors"
                        aria-label="元のチャットを開く"
                      >
                        <ExternalLink size={14} />
                        チャットへ
                      </Link>
                    )}
                    {assigneeRows.length > 0 && (
                      <span className="text-xs text-gray-500">
                        担当: {assigneeRows.map((s) => s.name).join(", ")}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openEdit(t)}
                      className="p-1.5 rounded-lg hover:bg-primary-subtle text-gray-500 hover:text-primary transition-colors"
                      aria-label="編集"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteTask(t.id)}
                      className="p-1.5 rounded-lg hover:bg-red-50 text-gray-500 hover:text-red-600 transition-colors"
                      aria-label="削除"
                    >
                      <Trash2 size={14} />
                    </button>
                    <Button
                      type="button"
                      size="sm"
                      className={cn(
                        "ml-1 min-h-[36px]",
                        t.completed
                          ? "bg-gray-100 text-gray-700 hover:bg-gray-200"
                          : "gradient-primary text-primary-foreground shadow-green"
                      )}
                      onClick={() => toggleComplete(t)}
                    >
                      <CheckCircle2 size={14} className="mr-1" />
                      {t.completed ? "未完了に戻す" : "完了"}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <TaskEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        task={editingTask}
        staff={staff}
        onSaved={handleSaved}
      />
    </div>
  );
}
