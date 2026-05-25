"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Search, Users as UsersIcon,
  ChevronRight, User,
  AlertCircle, Loader2, RefreshCw, Download,
  MessageSquarePlus, CheckCircle2,
} from "lucide-react";
import ColdStartSendModal, { type ColdStartSendTarget } from "@/components/ColdStartSendModal";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { StaffSendKindPill, type LastStaffSendKind } from "@/components/StaffSendKindPill";
import { HandlingStatusBadge } from "@/components/HandlingStatusBadge";
import {
  dispatchShopNotificationsRefresh,
  sumNewNotificationIdsFromSyncResults,
} from "@/lib/chapee-shop-notifications-events";
import { matchChatSearchQuery } from "@/lib/chat-search";

import { marketFilterChipsWithAll } from "@/lib/shopee-markets";
import {
  type HandlingStatus,
  HANDLING_STATUS_BADGE_STYLE,
  HANDLING_STATUS_LABELS,
  HANDLING_STATUS_ROW_STYLE,
  HANDLING_STATUS_VALUES,
  isHandlingStatus,
} from "@/lib/handling-status";

const COUNTRIES = marketFilterChipsWithAll();

type ChatRow = {
  id: string;
  country: string;
  customer: string;
  product: string;
  lastMessage: string;
  time: string;
  date: string;
  elapsed: number;
  staff: string;
  unread: number;
  handling_status: HandlingStatus;
  /** Chapee 経由で記録された直近の店舗送信 */
  last_staff_send_kind?: LastStaffSendKind | null;
};

type ColdStartBuyer = {
  shop_id: number;
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

const COLD_START_DEBOUNCE_MS = 500;
const COLD_START_MIN_CHARS = 2;

function formatColdStartDate(iso: string): string {
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

export default function ChatsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [selectedCountry, setSelectedCountry] = useState("全て");
  const [selectedHandling, setSelectedHandling] = useState<HandlingStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selectedChats, setSelectedChats] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  /** 「返信なし対応完了」の確認対象。単体は会話ID、一括は "bulk"。 */
  const [completeTarget, setCompleteTarget] = useState<string | "bulk" | null>(null);
  const [completing, setCompleting] = useState(false);

  // コールドスタート検索 (会話なし注文バイヤー)
  const [coldStartResults, setColdStartResults] = useState<ColdStartBuyer[]>([]);
  const [coldStartLoading, setColdStartLoading] = useState(false);
  const [sendTarget, setSendTarget] = useState<ColdStartSendTarget | null>(null);

  useEffect(() => {
    const c = searchParams.get("country");
    if (c && COUNTRIES.includes(c)) setSelectedCountry(c);
    const u = searchParams.get("unread_only") ?? searchParams.get("unread");
    if (u === "1" || u === "true") setUnreadOnly(true);
    const h = searchParams.get("handling");
    if (h === "all" || h === "") setSelectedHandling("all");
    else if (h && isHandlingStatus(h)) setSelectedHandling(h);
    const q = searchParams.get("q");
    if (q) setSearch(q);
  }, [searchParams]);

  useEffect(() => {
    setCurrentPage(1);
  }, [selectedHandling, selectedCountry, unreadOnly, search]);

  // コールドスタート検索: 検索文字列が 2 文字以上の時、 500ms デバウンスで全 shop 並列検索
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed.length < COLD_START_MIN_CHARS) {
      setColdStartResults([]);
      setColdStartLoading(false);
      return;
    }
    let cancelled = false;
    setColdStartLoading(true);
    const handle = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: trimmed, days: "30" });
        const res = await fetch(`/api/buyers/search?${params.toString()}`);
        if (!res.ok) {
          if (!cancelled) setColdStartResults([]);
          return;
        }
        const data = (await res.json()) as { buyers?: ColdStartBuyer[] };
        if (!cancelled) {
          // 会話なしのバイヤーのみ表示 (会話ありは既存リストが拾う)
          const filtered = (data.buyers ?? []).filter((b) => !b.has_conversation);
          setColdStartResults(filtered);
        }
      } catch (e) {
        console.error("[ChatsPage] cold-start search:", e);
        if (!cancelled) setColdStartResults([]);
      } finally {
        if (!cancelled) setColdStartLoading(false);
      }
    }, COLD_START_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [search]);

  /** loadChats の世代カウンタ。古いフェッチの後着上書きを防ぐ。 */
  const loadSeqRef = useRef(0);
  const loadChats = useCallback(async () => {
    // 同時に複数の loadChats が走った場合、最後に開始したものだけが setChats する
    // （手動更新と初回ロードが競合したときの後着上書きを防ぐ）。
    const seq = ++loadSeqRef.current;
    // 全会話を取得する。Shopee の Seller Center 通知は会話ではなく
    // /notifications ページ (get_shop_notification) に出るため、chat_type で除外しない。
    const res = await fetch("/api/chats");
    if (!res.ok) throw new Error("Failed to load chats");
    const data = await res.json();
    const rows: ChatRow[] = (data.chats || []).map(
      (c: {
        id: string;
        country: string;
        customer: string;
        lastMessage: string;
        time: string;
        elapsed: number;
        staff?: string;
        unread: number;
        handling_status?: HandlingStatus;
        product?: string;
        date?: string;
        last_staff_send_kind?: LastStaffSendKind | null;
      }) => ({
        id: String(c.id),
        country: c.country,
        customer: c.customer,
        product: c.product ?? "—",
        lastMessage: c.lastMessage,
        time: c.time,
        date: c.date ?? "",
        elapsed: c.elapsed,
        staff: c.staff ?? "未割当",
        unread: c.unread,
        handling_status: isHandlingStatus(c.handling_status)
          ? c.handling_status
          : "completed",
        last_staff_send_kind: c.last_staff_send_kind ?? null,
      })
    );
    // 後発の loadChats が既に走っていたら、この（古い）結果は捨てる
    if (seq === loadSeqRef.current) setChats(rows);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        await loadChats();
      } catch (e) {
        console.error(e);
        toast.error("チャット一覧の読み込みに失敗しました");
      } finally {
        setLoading(false);
      }
    })();
  }, [loadChats]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/shopee/sync", { method: "POST" });
      const data = (await res.json()) as {
        results?: Array<{
          error?: string;
          delta?: { new_notification_ids?: string[] };
        }>;
      };
      if (res.ok) {
        dispatchShopNotificationsRefresh({
          newNotificationIdsTotal: sumNewNotificationIdsFromSyncResults(
            data.results
          ),
        });
      }
      await loadChats();
    } catch (e) {
      toast.error("同期に失敗しました");
    } finally {
      setRefreshing(false);
    }
  };

  /** Shopeeから最新メッセージを能動的に取得して一覧を更新する */
  const handleFetchMessages = async () => {
    setFetching(true);
    try {
      const res = await fetch("/api/shopee/sync", { method: "POST" });
      const data = (await res.json()) as {
        error?: string;
        results?: Array<{
          error?: string;
          delta?: { new_conversation_ids?: string[]; new_notification_ids?: string[] };
        }>;
        auto_reply_after_sync?: { sent: number };
      };
      if (!res.ok) throw new Error(data.error || "取得に失敗しました");

      dispatchShopNotificationsRefresh({
        newNotificationIdsTotal: sumNewNotificationIdsFromSyncResults(data.results),
      });

      await loadChats();

      const newMsgs = data.results?.reduce(
        (s, r) => s + (r.delta?.new_conversation_ids?.length ?? 0),
        0
      ) ?? 0;
      const autoSent = data.auto_reply_after_sync?.sent ?? 0;

      if (newMsgs > 0) {
        toast.success(`${newMsgs}件の新着会話を取得しました`);
      } else {
        toast.success("メッセージを取得しました（新着なし）");
      }
      if (autoSent > 0) {
        toast.info(`自動返信を ${autoSent} 件送信しました`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "取得に失敗しました");
    } finally {
      setFetching(false);
    }
  };

  const filtered = chats.filter((c) => {
    const matchCountry = selectedCountry === "全て" || c.country === selectedCountry;
    const matchHandling =
      selectedHandling === "all" || c.handling_status === selectedHandling;
    const matchSearch = matchChatSearchQuery(search, c);
    const matchUnread = !unreadOnly || c.unread > 0;
    return matchCountry && matchHandling && matchSearch && matchUnread;
  });

  const totalUnreadMessages = chats.reduce((s, c) => s + (c.unread > 0 ? c.unread : 0), 0);
  const unreadConversationCount = chats.filter((c) => c.unread > 0).length;

  const totalPages = Math.ceil(filtered.length / itemsPerPage);
  const paginatedChats = filtered.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  const toggleSelectAll = () => {
    if (selectedChats.length === paginatedChats.length) {
      setSelectedChats([]);
    } else {
      setSelectedChats(paginatedChats.map(c => c.id));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedChats((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  const handleBulkAssign = () => {
    if (selectedChats.length === 0) {
      alert("チャットを選択してください");
      return;
    }
    toast.info(`${selectedChats.length}件の一括割当は、担当者API連携後に有効にできます`);
  };

  /** 確認ダイアログで「対応完了にする」を押した時の実処理（単体 / 一括 共通） */
  const handleConfirmComplete = async () => {
    if (!completeTarget) return;
    const isBulk = completeTarget === "bulk";
    const ids = isBulk ? selectedChats : [completeTarget];
    if (ids.length === 0) {
      setCompleteTarget(null);
      return;
    }
    setCompleting(true);
    try {
      if (isBulk) {
        const res = await fetch("/api/chats/bulk-complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversation_ids: ids }),
        });
        if (!res.ok) throw new Error("bulk failed");
      } else {
        const res = await fetch(`/api/chats/${encodeURIComponent(ids[0])}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ handling_status: "completed" }),
        });
        if (!res.ok) throw new Error("patch failed");
      }
      await loadChats();
      if (isBulk) setSelectedChats([]);
      toast.success(`${ids.length}件を対応完了にしました（返信なし）`);
    } catch {
      toast.error("対応完了への更新に失敗しました");
    } finally {
      setCompleting(false);
      setCompleteTarget(null);
    }
  };

  return (
    <div className="space-y-5 animate-fade-in max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-gray-900 font-bold text-lg">チャット管理</h2>
          <div className="mt-2 flex flex-col gap-2">
            {unreadConversationCount > 0 && (
              <p className="text-sm font-semibold text-amber-900 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-lg bg-amber-100 border border-amber-200 px-2.5 py-1 tabular-nums">
                  <AlertCircle size={14} />
                  未読会話 {unreadConversationCount} 件 / 未読 {totalUnreadMessages} 通
                </span>
              </p>
            )}
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-xs text-gray-500 font-medium">対応状況:</span>
              {HANDLING_STATUS_VALUES.map((h) => {
                const count = chats.filter((c) => c.handling_status === h).length;
                return (
                  <span
                    key={h}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums",
                      HANDLING_STATUS_BADGE_STYLE[h]
                    )}
                  >
                    {HANDLING_STATUS_LABELS[h]} {count}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={handleFetchMessages}
            disabled={fetching || loading}
            className="gap-2 rounded-xl"
          >
            {fetching ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Download size={16} />
            )}
            {fetching ? "取得中…" : "最新メッセージを取得"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing || loading}
            className="gap-2 rounded-xl"
          >
            {refreshing ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <RefreshCw size={16} />
            )}
            Shopeeと同期
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCompleteTarget("bulk")}
            disabled={selectedChats.length === 0 || completing}
            className="gap-2 rounded-xl border-emerald-300 text-emerald-800 hover:bg-emerald-50 hover:text-emerald-900"
          >
            <CheckCircle2 size={16} />
            選択を対応完了（返信なし）
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleBulkAssign}
            disabled={selectedChats.length === 0}
            className="gap-2 rounded-xl"
          >
            <UsersIcon size={16} />
            一括担当者割当
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 space-y-4">
        {/* Search */}
        <div className="relative">
          <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            placeholder="顧客名・商品名・メッセージ・注文ID・バイヤー名で検索（2文字以上で会話なし注文も検索）"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-10 rounded-xl border-gray-200"
          />
          {coldStartLoading && (
            <Loader2
              size={16}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 animate-spin"
            />
          )}
        </div>

        {/* Country Filter */}
        <div>
          <label className="text-gray-700 text-sm font-semibold mb-2 block">国</label>
          <div className="flex gap-2 flex-wrap">
            {COUNTRIES.map(c => (
              <button
                key={c}
                onClick={() => setSelectedCountry(c)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-sm font-medium transition-all border",
                  selectedCountry === c
                    ? "bg-primary text-white border-primary"
                    : "bg-white text-gray-700 border-gray-200 hover:border-primary/50"
                )}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        {/* Unread filter */}
        <div>
          <label className="text-gray-700 text-sm font-semibold mb-2 block">未読</label>
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setUnreadOnly(false)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-sm font-medium transition-all border",
                !unreadOnly
                  ? "bg-primary text-white border-primary"
                  : "bg-white text-gray-700 border-gray-200 hover:border-primary/50"
              )}
            >
              すべて
            </button>
            <button
              type="button"
              onClick={() => setUnreadOnly(true)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-sm font-medium transition-all border flex items-center gap-1.5",
                unreadOnly
                  ? "bg-red-600 text-white border-red-600"
                  : "bg-white text-gray-700 border-gray-200 hover:border-red-300"
              )}
            >
              <AlertCircle size={14} />
              未読のみ
            </button>
          </div>
        </div>

        {/* 対応ステータス（未返信 / 自動返信のみ・要対応 / 対応中 / 完了） */}
        <div>
          <label className="text-gray-700 text-sm font-semibold mb-2 block">
            対応ステータス
          </label>
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setSelectedHandling("all")}
              className={cn(
                "px-3 py-1.5 rounded-lg text-sm font-medium transition-all border",
                selectedHandling === "all"
                  ? "bg-primary text-white border-primary"
                  : "bg-white text-gray-700 border-gray-200 hover:border-primary/50"
              )}
            >
              すべて
            </button>
            {HANDLING_STATUS_VALUES.map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => setSelectedHandling(h)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-sm font-medium transition-all border max-w-[min(100%,220px)] text-left leading-snug",
                  selectedHandling === h
                    ? "bg-primary text-white border-primary"
                    : "bg-white text-gray-700 border-gray-200 hover:border-primary/50"
                )}
              >
                {HANDLING_STATUS_LABELS[h]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Results Summary */}
      <div className="flex items-center justify-between text-sm flex-wrap gap-2">
        <span className="text-gray-600">
          表示 {filtered.length} 件 / 全 {chats.length} 件（{selectedChats.length} 件選択中）
        </span>
        <span className="text-gray-500">
          ページ {currentPage} / {totalPages}
        </span>
      </div>

      {/* Chat List Table */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left">
                  <input
                    type="checkbox"
                    checked={selectedChats.length === paginatedChats.length && paginatedChats.length > 0}
                    onChange={toggleSelectAll}
                    className="rounded border-gray-300"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">国</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">未読</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">顧客名</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">店舗最終送信</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">商品</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">最終メッセージ</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">日時</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">経過時間</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">対応ステータス</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700">担当者</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={12} className="px-4 py-16 text-center text-gray-500">
                    <Loader2 className="animate-spin inline-block mr-2" size={20} />
                    読み込み中...
                  </td>
                </tr>
              ) : (
              paginatedChats.map(chat => {
                const hs = chat.handling_status;
                const rowStyle = HANDLING_STATUS_ROW_STYLE[hs] ?? "";
                const urgentUnread =
                  hs === "unreplied" &&
                  chat.unread > 0 &&
                  chat.elapsed >= 8;
                return (
                  <tr 
                    key={chat.id}
                    className={cn(
                      "hover:bg-gray-50 cursor-pointer transition-colors",
                      rowStyle,
                      urgentUnread && chat.elapsed >= 11 && "bg-red-100/40",
                      urgentUnread &&
                        chat.elapsed < 11 &&
                        chat.elapsed >= 8 &&
                        "bg-orange-50/50"
                    )}
                    onClick={() => router.push(`/chats/${chat.id}`)}
                  >
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedChats.includes(chat.id)}
                        onChange={() => toggleSelect(chat.id)}
                        className="rounded border-gray-300"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-primary text-white text-xs font-bold">
                        {chat.country}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {chat.unread > 0 ? (
                        <span className="inline-flex min-w-[2rem] justify-center items-center rounded-full bg-red-600 text-white text-xs font-bold px-2 py-0.5 tabular-nums">
                          {chat.unread}
                        </span>
                      ) : (
                        <span className="text-gray-300 text-xs">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-gray-900 font-medium text-sm">{chat.customer}</span>
                        {chat.unread > 0 && (
                          <span className="text-[10px] font-bold uppercase tracking-wide text-red-600 bg-red-100 px-1.5 py-0.5 rounded">
                            要対応
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StaffSendKindPill kind={chat.last_staff_send_kind} />
                    </td>
                    <td className="px-4 py-3 text-gray-600 text-sm">{chat.product}</td>
                    <td className="px-4 py-3 text-gray-600 text-sm max-w-xs truncate">{chat.lastMessage}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      <div className="flex flex-col">
                        <span>{chat.date}</span>
                        <span className="text-gray-400">{chat.time}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-gray-900 font-medium text-sm">{chat.elapsed}h</span>
                    </td>
                    <td className="px-4 py-3">
                      <HandlingStatusBadge status={hs} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <User size={14} className="text-gray-400" />
                        <span className="text-gray-700 text-sm">{chat.staff}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {hs !== "completed" && (
                          <button
                            type="button"
                            title="返信せずに対応完了にする"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCompleteTarget(chat.id);
                            }}
                            disabled={completing}
                            className="inline-flex items-center gap-1 rounded-md border border-emerald-300 text-emerald-700 hover:bg-emerald-50 px-2 py-1 text-[11px] font-medium disabled:opacity-50"
                          >
                            <CheckCircle2 size={13} />
                            完了
                          </button>
                        )}
                        <ChevronRight size={16} className="text-gray-400" />
                      </div>
                    </td>
                  </tr>
                );
              })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="rounded-xl"
            >
              前へ
            </Button>
            <div className="flex gap-1">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                <button
                  key={page}
                  onClick={() => setCurrentPage(page)}
                  className={cn(
                    "w-8 h-8 rounded-lg text-sm font-medium transition-colors",
                    currentPage === page
                      ? "bg-primary text-white"
                      : "text-gray-700 hover:bg-gray-100"
                  )}
                >
                  {page}
                </button>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="rounded-xl"
            >
              次へ
            </Button>
          </div>
        )}
      </div>

      {/* Cold-start results (会話なし注文バイヤー) */}
      {search.trim().length >= COLD_START_MIN_CHARS && (coldStartLoading || coldStartResults.length > 0) && (
        <div className="bg-white rounded-2xl border border-amber-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-amber-200 bg-amber-50/40">
            <h3 className="text-sm font-semibold text-amber-900 flex items-center gap-2">
              <MessageSquarePlus size={16} />
              会話なし注文バイヤー
              {!coldStartLoading && (
                <span className="text-xs font-normal text-amber-700">
                  ({coldStartResults.length} 件)
                </span>
              )}
            </h3>
            <p className="text-[11px] text-amber-700 mt-1">
              全 shop の過去 30 日の注文から、まだ会話のないバイヤーを検索しています
            </p>
          </div>
          {coldStartLoading ? (
            <div className="flex items-center justify-center py-6 text-sm text-gray-500 gap-2">
              <Loader2 size={14} className="animate-spin" />
              検索中...
            </div>
          ) : coldStartResults.length === 0 ? null : (
            <ul className="divide-y divide-amber-100">
              {coldStartResults.map((r) => (
                <li
                  key={`${r.shop_id}-${r.order_sn}-${r.buyer_user_id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-amber-50/30"
                >
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-gray-900">
                        {r.buyer_username}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-amber-100 text-amber-800">
                        会話なし
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-gray-100 text-gray-700">
                        shop {r.shop_id}
                      </span>
                    </div>
                    <div className="text-xs text-gray-600 truncate">
                      {r.order_sn} · {r.item_preview || "—"}
                    </div>
                    <div className="text-[11px] text-gray-500">
                      {formatColdStartDate(r.order_create_time)}
                      {r.total_amount > 0 &&
                        ` · ${r.currency} ${r.total_amount.toLocaleString()}`}
                    </div>
                  </div>
                  <div className="flex-shrink-0">
                    <Button
                      size="sm"
                      onClick={() =>
                        setSendTarget({
                          shop_id: r.shop_id,
                          buyer_user_id: r.buyer_user_id,
                          buyer_username: r.buyer_username,
                          order_sn: r.order_sn,
                          item_preview: r.item_preview,
                          has_conversation: r.has_conversation,
                        })
                      }
                      className="gap-1.5"
                    >
                      <MessageSquarePlus size={14} />
                      メッセージを送る
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ColdStartSendModal
        target={sendTarget}
        onClose={() => setSendTarget(null)}
        onSent={(t) => {
          // 送信成功後 → 該当行を結果から削除 (会話が成立したので「会話なし」では無くなる)
          setColdStartResults((prev) =>
            prev.filter(
              (r) =>
                !(r.shop_id === t.shop_id && r.buyer_user_id === t.buyer_user_id),
            ),
          );
          // チャット一覧も更新
          void loadChats();
        }}
      />

      <AlertDialog
        open={completeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !completing) setCompleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>返信せずに対応完了にしますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {completeTarget === "bulk"
                ? `選択した ${selectedChats.length} 件を、バイヤーへ返信せずに「対応完了」にします。`
                : "この会話を、バイヤーへ返信せずに「対応完了」にします。"}
              <br />
              保留中の自動返信予約も解除されます。よろしいですか？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={completing}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleConfirmComplete();
              }}
              disabled={completing}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {completing ? "処理中…" : "対応完了にする"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
