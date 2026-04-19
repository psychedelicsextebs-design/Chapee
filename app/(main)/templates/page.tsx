"use client";

import { useState, useEffect, useCallback } from "react";
import { Plus, Edit2, Trash2, FileText, Check, Star, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { marketFilterChipsWithAll } from "@/lib/shopee-markets";

const COUNTRIES = marketFilterChipsWithAll();
const CATEGORIES = ["全て", "発送前", "配達後", "返品・交換", "一般対応", "自動返信"];
const CATEGORY_OPTIONS = CATEGORIES.filter((c) => c !== "全て");
const LANG_OPTIONS = ["JA", "EN", "ZH", "MS"];

type TemplateRow = {
  id: string;
  country: string;
  category: string;
  name: string;
  content: string;
  autoReply: boolean;
  langs: string[];
};

const langColors: Record<string, string> = {
  JA: "bg-primary-subtle text-primary border-primary/20",
  EN: "bg-success/10 text-success border-success/20",
  ZH: "bg-warning/10 text-warning border-warning/20",
  MS: "bg-blue-50 text-blue-600 border-blue-200",
};

export default function TemplatesPage() {
  const [selectedCountry, setSelectedCountry] = useState("全て");
  const [selectedCategory, setSelectedCategory] = useState("全て");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [editContent, setEditContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newCountry, setNewCountry] = useState("全て");
  const [newCategory, setNewCategory] = useState(CATEGORY_OPTIONS[0]);
  const [newName, setNewName] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newAutoReply, setNewAutoReply] = useState(false);
  const [newLangs, setNewLangs] = useState<string[]>(["JA"]);

  const resetCreateForm = useCallback(() => {
    setNewCountry("全て");
    setNewCategory(CATEGORY_OPTIONS[0]);
    setNewName("");
    setNewContent("");
    setNewAutoReply(false);
    setNewLangs(["JA"]);
  }, []);

  const toggleNewLang = (lang: string) => {
    setNewLangs((prev) =>
      prev.includes(lang) ? prev.filter((l) => l !== lang) : [...prev, lang]
    );
  };

  const createTemplate = async () => {
    if (!newName.trim() || !newContent.trim()) {
      toast.error("名前と内容を入力してください");
      return;
    }
    if (newLangs.length === 0) {
      toast.error("言語を1つ以上選択してください");
      return;
    }
    try {
      setCreating(true);
      const res = await fetch("/api/reply-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          country: newCountry,
          category: newCategory,
          name: newName.trim(),
          content: newContent,
          autoReply: newAutoReply,
          langs: newLangs,
        }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setTemplates((prev) => [...prev, data.template]);
      toast.success("テンプレートを追加しました");
      setCreateOpen(false);
      resetCreateForm();
    } catch {
      toast.error("追加に失敗しました");
    } finally {
      setCreating(false);
    }
  };

  const loadTemplates = useCallback(async () => {
    const res = await fetch("/api/reply-templates");
    if (!res.ok) throw new Error("load failed");
    const data = await res.json();
    setTemplates(data.templates || []);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        await loadTemplates();
      } catch {
        toast.error("テンプレートの読み込みに失敗しました");
      } finally {
        setLoading(false);
      }
    })();
  }, [loadTemplates]);

  const filtered = templates.filter((t) => {
    const matchCountry =
      selectedCountry === "全て" || t.country === "全て" || t.country === selectedCountry;
    const matchCat = selectedCategory === "全て" || t.category === selectedCategory;
    return matchCountry && matchCat;
  });

  const startEdit = (t: TemplateRow) => {
    setEditingId(t.id);
    setEditContent(t.content);
  };

  const saveEdit = async (id: string) => {
    try {
      const res = await fetch("/api/reply-templates", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, content: editContent }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setTemplates((prev) =>
        prev.map((t) => (t.id === id ? { ...t, content: data.template.content } : t))
      );
      setEditingId(null);
      toast.success("保存しました");
    } catch {
      toast.error("保存に失敗しました");
    }
  };

  const deleteTemplate = async (id: string) => {
    try {
      const res = await fetch(`/api/reply-templates?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error();
      setTemplates((prev) => prev.filter((t) => t.id !== id));
      toast.success("削除しました");
    } catch {
      toast.error("削除に失敗しました");
    }
  };

  return (
    <div className="space-y-4 sm:space-y-5 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-foreground font-bold text-base sm:text-lg">テンプレート管理</h2>
          <p className="text-muted-foreground text-sm mt-0.5">
            MongoDB に保存（初回アクセス時にデフォルトを投入）
          </p>
        </div>
        <Button
          className="gradient-primary text-primary-foreground shadow-green gap-1.5 w-full sm:w-auto min-h-[44px] sm:min-h-0"
          type="button"
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={15} />
          新規追加
        </Button>
      </div>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) resetCreateForm();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>テンプレートを新規追加</DialogTitle>
            <DialogDescription>
              新しい返信テンプレートを登録します。すべての項目を入力してください。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="tpl-country">対象国</Label>
                <Select value={newCountry} onValueChange={setNewCountry}>
                  <SelectTrigger id="tpl-country">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COUNTRIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c === "全て" ? "🌐 全国共通" : c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-category">カテゴリ</Label>
                <Select value={newCategory} onValueChange={setNewCategory}>
                  <SelectTrigger id="tpl-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORY_OPTIONS.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-name">テンプレート名</Label>
              <Input
                id="tpl-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="例: 発送完了のご案内"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-content">本文</Label>
              <Textarea
                id="tpl-content"
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder="お客様への返信メッセージを入力"
                className="min-h-[120px] resize-none"
              />
            </div>
            <div className="space-y-1.5">
              <Label>対応言語</Label>
              <div className="flex flex-wrap gap-2">
                {LANG_OPTIONS.map((lang) => {
                  const active = newLangs.includes(lang);
                  return (
                    <button
                      key={lang}
                      type="button"
                      onClick={() => toggleNewLang(lang)}
                      className={cn(
                        "px-3 py-1.5 rounded-lg text-xs font-medium border transition-all",
                        active
                          ? "gradient-primary text-primary-foreground border-transparent shadow-green"
                          : "bg-card text-muted-foreground border-border hover:bg-muted"
                      )}
                    >
                      {lang}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div>
                <p className="text-sm font-medium">自動返信に使用する</p>
                <p className="text-xs text-muted-foreground">
                  条件に一致したチャットで自動送信されます
                </p>
              </div>
              <Switch checked={newAutoReply} onCheckedChange={setNewAutoReply} />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCreateOpen(false);
                resetCreateForm();
              }}
              disabled={creating}
            >
              キャンセル
            </Button>
            <Button
              type="button"
              className="gradient-primary text-primary-foreground gap-1.5"
              onClick={createTemplate}
              disabled={creating}
            >
              {creating ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  追加中...
                </>
              ) : (
                <>
                  <Check size={14} />
                  追加する
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex items-center gap-1 bg-card border border-border rounded-xl p-1 shadow-card overflow-x-auto min-h-[44px]">
          {COUNTRIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setSelectedCountry(c)}
              className={cn(
                "px-3 py-2 sm:py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap min-h-[36px] sm:min-h-0",
                selectedCountry === c
                  ? "gradient-primary text-primary-foreground shadow-green"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 bg-card border border-border rounded-xl p-1 shadow-card overflow-x-auto min-h-[44px]">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setSelectedCategory(c)}
              className={cn(
                "px-3 py-2 sm:py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap min-h-[36px] sm:min-h-0",
                selectedCategory === c
                  ? "gradient-primary text-primary-foreground shadow-green"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="py-16 text-center text-muted-foreground text-sm">
          <Loader2 className="inline animate-spin mr-2" size={20} />
          読み込み中...
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
          {filtered.map((t) => (
            <div
              key={t.id}
              className="bg-card rounded-xl border border-border shadow-card overflow-hidden min-w-0"
            >
              <div className="px-4 py-3 border-b border-border flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="w-6 h-6 gradient-primary rounded-md flex items-center justify-center flex-shrink-0">
                    <FileText size={12} className="text-primary-foreground" />
                  </div>
                  <span className="text-foreground font-semibold text-sm">{t.name}</span>
                  {t.autoReply && (
                    <span className="flex items-center gap-1 text-xs px-2 py-0.5 bg-warning/15 text-warning border border-warning/30 rounded-full font-medium">
                      <Star size={9} />
                      自動返信
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => startEdit(t)}
                    className="p-1.5 rounded-lg hover:bg-primary-subtle text-muted-foreground hover:text-primary transition-all"
                  >
                    <Edit2 size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteTemplate(t.id)}
                    className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>

              <div className="p-4 space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs px-2 py-0.5 gradient-primary text-primary-foreground rounded-full font-medium">
                    {t.country === "全て" ? "🌐 全国共通" : `🏳️ ${t.country}`}
                  </span>
                  <span className="text-xs px-2 py-0.5 bg-secondary text-secondary-foreground rounded-full">
                    {t.category}
                  </span>
                  {t.langs.map((l) => (
                    <span
                      key={l}
                      className={cn(
                        "text-xs px-1.5 py-0.5 rounded border font-medium",
                        langColors[l] || "bg-muted text-muted-foreground"
                      )}
                    >
                      {l}
                    </span>
                  ))}
                </div>

                {editingId === t.id ? (
                  <div className="space-y-2">
                    <Textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className="text-sm resize-none min-h-[80px]"
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="gradient-primary text-primary-foreground gap-1"
                        type="button"
                        onClick={() => saveEdit(t.id)}
                      >
                        <Check size={12} /> 保存
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        type="button"
                        onClick={() => setEditingId(null)}
                      >
                        キャンセル
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-sm leading-relaxed line-clamp-3">
                    {t.content}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
