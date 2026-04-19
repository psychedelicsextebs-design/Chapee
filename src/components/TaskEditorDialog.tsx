"use client";

import { useEffect, useState } from "react";
import { ListTodo, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { SHOPEE_MARKET_CODES } from "@/lib/shopee-markets";
import { toast } from "sonner";
import type { TaskApi } from "@/lib/tasks";
import { dispatchTasksChanged } from "@/lib/tasks-events";

export type StaffOption = {
  id: string;
  name: string;
  email: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 編集中のタスク（null なら新規作成モード） */
  task?: TaskApi | null;
  /** 担当者候補 */
  staff: StaffOption[];
  /** 新規作成時のデフォルト値 */
  defaultTitle?: string;
  defaultContent?: string;
  /** 自動セット（チャット画面からの作成時に使用） */
  autoConversationId?: string | null;
  autoBuyerId?: string | null;
  autoCountry?: string | null;
  /** 保存完了時コールバック（新規 or 編集） */
  onSaved?: (task: TaskApi) => void;
};

/** yyyy-mm-ddThh:mm → ISO、空は null */
function datetimeLocalToISO(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Date ISO → yyyy-mm-ddThh:mm（datetime-local 用） */
function isoToDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TaskEditorDialog({
  open,
  onOpenChange,
  task = null,
  staff,
  defaultTitle = "",
  defaultContent = "",
  autoConversationId = null,
  autoBuyerId = null,
  autoCountry = null,
  onSaved,
}: Props) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [assignees, setAssignees] = useState<string[]>([]);
  const [dueDateLocal, setDueDateLocal] = useState("");
  const [country, setCountry] = useState("");
  const [saving, setSaving] = useState(false);

  const isEdit = Boolean(task);

  // Dialog が開いたタイミングでフォーム初期化
  useEffect(() => {
    if (!open) return;
    if (task) {
      setTitle(task.title);
      setContent(task.content);
      setAssignees([...task.assignees]);
      setDueDateLocal(isoToDatetimeLocal(task.due_date));
      setCountry(task.country ?? "");
    } else {
      setTitle(defaultTitle);
      setContent(defaultContent);
      setAssignees([]);
      setDueDateLocal("");
      setCountry(autoCountry ?? "");
    }
  }, [open, task, defaultTitle, defaultContent, autoCountry]);

  const toggleAssignee = (id: string) => {
    setAssignees((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const save = async () => {
    const t = title.trim();
    if (!t) {
      toast.error("タスク名を入力してください");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        title: t,
        content,
        assignees,
        due_date: datetimeLocalToISO(dueDateLocal),
        country: country || null,
      };
      if (!isEdit) {
        if (autoConversationId) body.conversation_id = autoConversationId;
        if (autoBuyerId) body.buyer_id = autoBuyerId;
      }
      const res = task
        ? await fetch(`/api/tasks/${task.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await fetch("/api/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { task: TaskApi };
      toast.success(isEdit ? "タスクを更新しました" : "タスクを作成しました");
      onSaved?.(data.task);
      onOpenChange(false);
      dispatchTasksChanged();
    } catch {
      toast.error("保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg border-border shadow-card">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 gradient-primary rounded-lg flex items-center justify-center">
              <ListTodo size={14} className="text-primary-foreground" />
            </div>
            <DialogTitle className="text-base">
              {isEdit ? "タスクを編集" : "タスクを追加"}
            </DialogTitle>
          </div>
          <DialogDescription className="text-left text-xs">
            タスク名は必須。担当者と期限は任意です。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">タスク名</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例: 要確認"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">内容</label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="詳細を入力（複数行可）"
              rows={4}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">担当者</label>
            {staff.length === 0 ? (
              <p className="text-xs text-gray-500">
                担当者が登録されていません。先に「担当者管理」から登録してください。
              </p>
            ) : (
              <div className="max-h-40 overflow-y-auto space-y-1 rounded-lg border border-border p-2">
                {staff.map((s) => {
                  const checked = assignees.includes(s.id);
                  return (
                    <label
                      key={s.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-primary-subtle/40 cursor-pointer"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleAssignee(s.id)}
                      />
                      <div className="w-6 h-6 rounded-full gradient-primary flex items-center justify-center flex-shrink-0">
                        <span className="text-primary-foreground font-bold text-[10px]">
                          {s.name[0]}
                        </span>
                      </div>
                      <span className="text-sm text-gray-800">{s.name}</span>
                      <span className="text-xs text-gray-400 ml-auto truncate max-w-[140px]">
                        {s.email}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">期限</label>
              <Input
                type="datetime-local"
                value={dueDateLocal}
                onChange={(e) => setDueDateLocal(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                国{autoCountry && !isEdit ? "（自動）" : "（任意）"}
              </label>
              <Select
                value={country || "none"}
                onValueChange={(v) => setCountry(v === "none" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">—</SelectItem>
                  {SHOPEE_MARKET_CODES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            キャンセル
          </Button>
          <Button
            size="sm"
            className="gradient-primary text-primary-foreground shadow-green"
            onClick={save}
            disabled={saving}
          >
            {saving ? (
              <>
                <Loader2 size={14} className="animate-spin mr-1" />
                保存中
              </>
            ) : (
              "保存"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
