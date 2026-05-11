"use client";

import { useState, useEffect } from "react";
import { Loader2, MessageSquarePlus, ChevronLeft } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

export type ColdStartSendTarget = {
  shop_id: number;
  buyer_user_id: number;
  buyer_username: string;
  order_sn: string;
  item_preview: string;
  has_conversation: boolean;
};

type Template = {
  id: string;
  country: string;
  category: string;
  name: string;
  content: string;
};

type Props = {
  target: ColdStartSendTarget | null;
  onClose: () => void;
  onSent?: (target: ColdStartSendTarget) => void;
};

export default function ColdStartSendModal({ target, onClose, onSent }: Props) {
  const [sendText, setSendText] = useState("");
  const [sendTemplateId, setSendTemplateId] = useState<string>("none");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [sending, setSending] = useState(false);

  // Reset on target change/close
  useEffect(() => {
    if (!target) {
      setSendText("");
      setSendTemplateId("none");
    }
  }, [target]);

  // Lazy-load templates on first open
  useEffect(() => {
    if (!target || templates.length > 0) return;
    (async () => {
      try {
        const res = await fetch("/api/reply-templates");
        if (!res.ok) return;
        const data = (await res.json()) as { templates?: Template[] };
        setTemplates(data.templates ?? []);
      } catch (e) {
        console.error("[ColdStartSendModal] load templates:", e);
      }
    })();
  }, [target, templates.length]);

  const handleApplyTemplate = (templateId: string) => {
    setSendTemplateId(templateId);
    if (templateId === "none") return;
    const t = templates.find((x) => x.id === templateId);
    if (t) setSendText(t.content);
  };

  const handleSend = async () => {
    if (!target) return;
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
          shop_id: target.shop_id,
          buyer_user_id: target.buyer_user_id,
          order_sn: target.order_sn,
          text: sendText.trim(),
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "送信に失敗しました");
      toast.success("メッセージを送信しました");
      onSent?.(target);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "送信に失敗しました");
    } finally {
      setSending(false);
    }
  };

  const open = target !== null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg border-border shadow-card">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <MessageSquarePlus size={16} />
            {target?.buyer_username ?? ""} さんにメッセージ送信
          </DialogTitle>
        </DialogHeader>
        {target && (
          <>
            <div className="space-y-3 py-2">
              <div className="text-xs text-muted-foreground space-y-0.5">
                <div>注文 ID: {target.order_sn}</div>
                <div>商品: {target.item_preview || "—"}</div>
                {!target.has_conversation && (
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
                onClick={onClose}
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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
