"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  Loader2,
  ExternalLink,
  MessageSquarePlus,
  ChevronLeft,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type ShopConnection = {
  shop_id: number;
  shop_name?: string;
  country: string;
};

type BuyerSearchResult = {
  buyer_user_id: number;
  buyer_username: string;
  order_sn: string;
  order_create_time: string;
  item_preview: string;
  currency: string;
  total_amount: number;
  has_conversation: boolean;
  conversation_id: string | null;
};

type Template = {
  id: string;
  country: string;
  category: string;
  name: string;
  content: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const PERIOD_OPTIONS = [
  { value: "7", label: "過去 7 日" },
  { value: "30", label: "過去 30 日" },
  { value: "90", label: "過去 90 日" },
];

function formatDate(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function BuyerSearchDialog({ open, onOpenChange }: Props) {
  const router = useRouter();
  const [shops, setShops] = useState<ShopConnection[]>([]);
  const [selectedShopId, setSelectedShopId] = useState<string>("");
  const [days, setDays] = useState<string>("30");
  const [q, setQ] = useState<string>("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<BuyerSearchResult[]>([]);
  const [searched, setSearched] = useState(false);

  // sub-modal (送信フォーム) 状態
  const [sendTarget, setSendTarget] = useState<BuyerSearchResult | null>(null);
  const [sendText, setSendText] = useState("");
  const [sendTemplateId, setSendTemplateId] = useState<string>("none");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [sending, setSending] = useState(false);

  // Reset state on close
  useEffect(() => {
    if (!open) {
      setResults([]);
      setQ("");
      setSearched(false);
      setSendTarget(null);
      setSendText("");
      setSendTemplateId("none");
    }
  }, [open]);

  // Load shops on first open
  useEffect(() => {
    if (!open || shops.length > 0) return;
    (async () => {
      try {
        const res = await fetch("/api/shopee/status");
        if (!res.ok) return;
        const data = (await res.json()) as { connections?: ShopConnection[] };
        const list = data.connections ?? [];
        setShops(list);
        if (list.length > 0 && !selectedShopId) {
          setSelectedShopId(String(list[0].shop_id));
        }
      } catch (e) {
        console.error("[BuyerSearchDialog] load shops:", e);
      }
    })();
  }, [open, shops.length, selectedShopId]);

  // Load templates lazily when sendTarget opens
  useEffect(() => {
    if (!sendTarget || templates.length > 0) return;
    (async () => {
      try {
        const res = await fetch("/api/reply-templates");
        if (!res.ok) return;
        const data = (await res.json()) as { templates?: Template[] };
        setTemplates(data.templates ?? []);
      } catch (e) {
        console.error("[BuyerSearchDialog] load templates:", e);
      }
    })();
  }, [sendTarget, templates.length]);

  const handleSearch = useCallback(async () => {
    if (!selectedShopId) {
      toast.error("ショップを選択してください");
      return;
    }
    setSearching(true);
    setSearched(false);
    try {
      const params = new URLSearchParams({
        shop_id: selectedShopId,
        days,
      });
      if (q.trim()) params.set("q", q.trim());
      const res = await fetch(`/api/buyers/search?${params.toString()}`);
      const data = (await res.json()) as {
        buyers?: BuyerSearchResult[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "検索に失敗しました");
      setResults(data.buyers ?? []);
      setSearched(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "検索に失敗しました");
    } finally {
      setSearching(false);
    }
  }, [selectedShopId, days, q]);

  const handleOpenSend = (target: BuyerSearchResult) => {
    setSendTarget(target);
    setSendText("");
    setSendTemplateId("none");
  };

  const handleApplyTemplate = (templateId: string) => {
    setSendTemplateId(templateId);
    if (templateId === "none") return;
    const t = templates.find((x) => x.id === templateId);
    if (t) setSendText(t.content);
  };

  const handleSend = async () => {
    if (!sendTarget) return;
    if (!sendText.trim()) {
      toast.error("本文を入力してください");
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/buyers/cold-start-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop_id: Number(selectedShopId),
          buyer_user_id: sendTarget.buyer_user_id,
          order_sn: sendTarget.order_sn,
          text: sendText.trim(),
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "送信に失敗しました");
      toast.success("メッセージを送信しました");
      // 結果リストで該当行を has_conversation=true 化 (再検索なしで UI 更新)
      setResults((prev) =>
        prev.map((r) =>
          r.buyer_user_id === sendTarget.buyer_user_id
            ? { ...r, has_conversation: true }
            : r,
        ),
      );
      setSendTarget(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "送信に失敗しました");
    } finally {
      setSending(false);
    }
  };

  const handleOpenChat = (conversationId: string) => {
    onOpenChange(false);
    router.push(`/chats/${conversationId}`);
  };

  // === Render: 送信サブモーダル状態 ===
  if (sendTarget) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg border-border shadow-card">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <MessageSquarePlus size={16} />
              {sendTarget.buyer_username} さんにメッセージ送信
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="text-xs text-muted-foreground space-y-0.5">
              <div>注文 ID: {sendTarget.order_sn}</div>
              <div>商品: {sendTarget.item_preview || "—"}</div>
              {!sendTarget.has_conversation && (
                <div className="text-amber-700 text-xs mt-2">
                  ※ 既存会話なし → 注文カード送信で会話を確立してから本文を送信します
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">テンプレート (任意)</Label>
              <Select
                value={sendTemplateId}
                onValueChange={handleApplyTemplate}
              >
                <SelectTrigger>
                  <SelectValue placeholder="テンプレート選択" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">テンプレートを使わない</SelectItem>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      [{t.country}/{t.category}] {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">本文</Label>
              <textarea
                value={sendText}
                onChange={(e) => setSendText(e.target.value)}
                rows={6}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
                placeholder="送信するメッセージ本文を入力..."
              />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSendTarget(null)}
              disabled={sending}
              className="gap-1.5"
            >
              <ChevronLeft size={14} />
              戻る
            </Button>
            <Button
              size="sm"
              onClick={handleSend}
              disabled={sending || !sendText.trim()}
              className="gap-1.5"
            >
              {sending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <MessageSquarePlus size={14} />
              )}
              送信
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // === Render: 検索モーダル状態 ===
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto border-border shadow-card">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <Search size={16} />
            新規メッセージ — バイヤー検索
          </DialogTitle>
        </DialogHeader>

        {/* 検索フォーム */}
        <div className="space-y-3 py-2">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">ショップ</Label>
              <Select
                value={selectedShopId}
                onValueChange={setSelectedShopId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="ショップ選択" />
                </SelectTrigger>
                <SelectContent>
                  {shops.map((s) => (
                    <SelectItem key={s.shop_id} value={String(s.shop_id)}>
                      {s.shop_name ?? `shop ${s.shop_id}`} ({s.country})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">期間</Label>
              <Select value={days} onValueChange={setDays}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERIOD_OPTIONS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">検索 (注文 ID / バイヤー名)</Label>
              <div className="flex gap-2">
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="空欄で期間内全件"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleSearch();
                    }
                  }}
                  className="flex-1"
                />
                <Button
                  size="sm"
                  onClick={handleSearch}
                  disabled={searching || !selectedShopId}
                  className="gap-1.5"
                >
                  {searching ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Search size={14} />
                  )}
                  検索
                </Button>
              </div>
            </div>
          </div>

          {/* 結果リスト */}
          {searching ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground gap-2">
              <Loader2 size={14} className="animate-spin" />
              検索中...
            </div>
          ) : searched && results.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              該当する注文が見つかりませんでした
            </div>
          ) : results.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {results.length} 件の注文が見つかりました
              </p>
              {results.map((r) => (
                <div
                  key={`${r.order_sn}-${r.buyer_user_id}`}
                  className={cn(
                    "flex items-center justify-between gap-3 p-3 rounded-lg border bg-card",
                    r.has_conversation
                      ? "border-border"
                      : "border-amber-200 bg-amber-50/30",
                  )}
                >
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">
                        {r.buyer_username}
                      </span>
                      <span
                        className={cn(
                          "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                          r.has_conversation
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-amber-100 text-amber-800",
                        )}
                      >
                        {r.has_conversation ? "会話あり" : "会話なし"}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {r.order_sn} · {r.item_preview || "—"}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {formatDate(r.order_create_time)}
                      {r.total_amount > 0 &&
                        ` · ${r.currency} ${r.total_amount.toLocaleString()}`}
                    </div>
                  </div>
                  <div className="flex-shrink-0">
                    {r.has_conversation && r.conversation_id ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleOpenChat(r.conversation_id!)}
                        className="gap-1.5"
                      >
                        <ExternalLink size={14} />
                        既存チャットを開く
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => handleOpenSend(r)}
                        className="gap-1.5"
                      >
                        <MessageSquarePlus size={14} />
                        メッセージを送る
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
