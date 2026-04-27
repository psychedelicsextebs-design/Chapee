"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  MessageSquare, Clock, AlertCircle,
  ChevronRight, RefreshCw, Loader2, Settings,
  ShoppingCart, Bell, TrendingUp, CheckCircle2, XCircle,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { matchChatSearchQuery } from "@/lib/chat-search";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useNotificationSounds } from "@/lib/useNotificationSounds";
import { getNotificationSoundsEnabled } from "@/lib/notification-sound-settings";
import { StaffSendKindPill, type LastStaffSendKind } from "@/components/StaffSendKindPill";
import {
  dispatchShopNotificationsRefresh,
  sumNewNotificationIdsFromSyncResults,
} from "@/lib/chapee-shop-notifications-events";
import { marketFilterChipsWithAll } from "@/lib/shopee-markets";
import { safeJsonFetch, formatSafeFetchError } from "@/lib/safe-fetch";

const COUNTRIES = marketFilterChipsWithAll();

/** ダッシュボード表示中の自動同期間隔（ミリ秒） */
const DASHBOARD_AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000;

/**
 * sync エンドポイントのクライアント側タイムアウト (ms)。
 * Vercel Pro Function は最大 60 秒で打ち切られるので、それより少し長く取る。
 * これを超えたら確実に裏側が timeout している → AbortController で fetch を中断、
 * 「同期中」表示が永遠に消えない事故を根絶する。
 */
const SYNC_FETCH_TIMEOUT_MS = 70_000;
/** /api/chats は軽い参照クエリなのでもっと短く */
const CHATS_FETCH_TIMEOUT_MS = 20_000;
/** /api/shopee/connect は OAuth 後処理。長すぎず短すぎず */
const CONNECT_FETCH_TIMEOUT_MS = 30_000;

type SyncApiResponse = {
  success?: boolean;
  message?: string;
  error?: string;
  results?: SyncApiResultRow[];
};
type ChatsApiResponse = { chats?: Chat[] };

type SyncResultDelta = {
  new_conversation_ids?: string[];
  new_notification_ids?: string[];
};

type SyncApiResultRow = {
  shop_id: number;
  error?: string;
  delta?: SyncResultDelta;
};

function playSoundsForSyncDelta(
  results: SyncApiResultRow[] | undefined,
  playMessageSound: () => void,
  playOrderSound: () => void
): void {
  if (!getNotificationSoundsEnabled() || !results?.length) return;
  let hasNewChat = false;
  let hasNewNotif = false;
  for (const r of results) {
    if (r.error) continue;
    const d = r.delta;
    if (!d) continue;
    if (d.new_conversation_ids?.length) hasNewChat = true;
    if (d.new_notification_ids?.length) hasNewNotif = true;
  }
  if (hasNewChat) playMessageSound();
  if (hasNewNotif) playOrderSound();
}

// チャットタイプ定義
type ChatType = "buyer" | "notification" | "affiliate";


const chatTypeConfig = {
  buyer: { 
    label: "バイヤー", 
    icon: ShoppingCart, 
    color: "text-blue-600", 
    bg: "bg-blue-50",
    description: "通常のバイヤーからのチャット"
  },
  notification: { 
    label: "通知", 
    icon: Bell, 
    color: "text-amber-600", 
    bg: "bg-amber-50",
    description: "Shopeeからの各種通知"
  },
  affiliate: { 
    label: "アフィリエイト", 
    icon: TrendingUp, 
    color: "text-purple-600", 
    bg: "bg-purple-50",
    description: "アフィリエイターからのチャット"
  },
};

type Chat = {
  id: string;
  shop_id: number;
  country: string;
  customer: string;
  customer_id: number;
  lastMessage: string;
  time: string;
  elapsed: number;
  staff?: string;
  unread: number;
  pinned: boolean;
  status: string;
  type?: ChatType;
  last_staff_send_kind?: LastStaffSendKind | null;
};

type SyncStatus = "idle" | "syncing" | "success" | "error";

export default function DashboardPage() {
  const router = useRouter();
  const { playMessageSound, playOrderSound } = useNotificationSounds();
  const [loading, setLoading] = useState(true);
  /** User clicked「データ更新」 */
  const [manualSyncing, setManualSyncing] = useState(false);
  /** POST /api/shopee/sync running in background after first paint */
  const [backgroundSyncing, setBackgroundSyncing] = useState(false);
  const [chats, setChats] = useState<Chat[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const backgroundSyncInFlightRef = useRef(false);
  /** Misconfigured redirect (e.g. Google): user pastes ?code=&shop_id= onto this page */
  const oauthRecoveryRef = useRef(false);
  /** 同期開始時刻 (UI 表示用、経過秒数の計算と auto-clear 安全網のため) */
  const [syncStartedAt, setSyncStartedAt] = useState<Date | null>(null);

  // ★ 絶対安全網: どんな経路で flag が立ったままになっても 75 秒で必ずクリア。
  //   safeJsonFetch のタイムアウトが効けばここまで来ないが、未来のコード変更で
  //   finally が漏れても「同期中」が永遠に残る事故を起こさないための保険。
  useEffect(() => {
    if (!manualSyncing && !backgroundSyncing) {
      setSyncStartedAt(null);
      return;
    }
    if (!syncStartedAt) setSyncStartedAt(new Date());
    const id = window.setTimeout(() => {
      setManualSyncing(false);
      setBackgroundSyncing(false);
      backgroundSyncInFlightRef.current = false;
      setSyncStatus((s) => (s === "syncing" ? "error" : s));
      setSyncError(
        (e) =>
          e ??
          "同期表示が長時間続いたため UI を解除しました。バックエンドで処理が継続している可能性があります。"
      );
    }, 75_000);
    return () => window.clearTimeout(id);
  }, [manualSyncing, backgroundSyncing, syncStartedAt]);

  // Shopee OAuth: callback redirects to /dashboard?shopee_connected=… or ?shopee_error=…
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("shopee_connected");
    const err = params.get("shopee_error");
    if (connected !== "true" && !err) return;

    if (connected === "true") {
      toast.success("Shopeeアカウントを接続しました");
    } else if (err) {
      toast.error(decodeURIComponent(err));
    }
    router.replace("/dashboard", { scroll: false });
  }, [router]);

  const fetchChats = useCallback(async () => {
    // safeJsonFetch: タイムアウト + ok/content-type 検査を一括で適用。
    // 旧コードは res.json() の前に res.ok チェックがなく「Unexpected token 'A'」
    // を踏んでいた。
    const data = await safeJsonFetch<ChatsApiResponse>(
      "/api/chats",
      {},
      { timeoutMs: CHATS_FETCH_TIMEOUT_MS, label: "/api/chats" }
    );
    return (data.chats || []).map((chat: Chat) => ({
      ...chat,
      type: chat.type || ("buyer" as ChatType),
      last_staff_send_kind: chat.last_staff_send_kind ?? null,
    }));
  }, []);

  const runBackgroundSync = useCallback(async () => {
    if (backgroundSyncInFlightRef.current) return;
    backgroundSyncInFlightRef.current = true;
    setBackgroundSyncing(true);
    setSyncStatus("syncing");
    setSyncError(null);
    try {
      const data = await safeJsonFetch<SyncApiResponse>(
        "/api/shopee/sync",
        { method: "POST" },
        { timeoutMs: SYNC_FETCH_TIMEOUT_MS, label: "/api/shopee/sync" }
      );
      if (data.error) throw new Error(data.error);
      playSoundsForSyncDelta(data.results, playMessageSound, playOrderSound);
      dispatchShopNotificationsRefresh({
        newNotificationIdsTotal: sumNewNotificationIdsFromSyncResults(
          data.results
        ),
      });
      setSyncStatus("success");
      setLastSynced(new Date());
      setChats(await fetchChats());
    } catch (err) {
      // 失敗種別に応じた読みやすいメッセージに整形
      const msg = formatSafeFetchError(err);
      setSyncStatus("error");
      setSyncError(msg);
      console.warn("[dashboard] background sync failed:", err);
    } finally {
      // ★ 必ずクリアする (タイムアウト系で「同期中」表示が永遠に残る事故を防ぐ)
      setBackgroundSyncing(false);
      backgroundSyncInFlightRef.current = false;
    }
  }, [fetchChats, playMessageSound, playOrderSound]);

  // Redirect URL が Google 等のとき: アドレスバーの code / shop_id を付けて /dashboard を開いた場合の救済
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const shopId = params.get("shop_id");
    if (!code || !shopId) return;
    if (params.get("shopee_connected") === "true" || params.get("shopee_error"))
      return;
    if (oauthRecoveryRef.current) return;
    oauthRecoveryRef.current = true;

    (async () => {
      try {
        const data = await safeJsonFetch<{ error?: string }>(
          "/api/shopee/connect",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              code,
              shop_id: shopId,
              country: params.get("country") ?? undefined,
              region: params.get("region") ?? undefined,
            }),
          },
          { timeoutMs: CONNECT_FETCH_TIMEOUT_MS, label: "/api/shopee/connect" }
        );
        if (data.error) throw new Error(data.error);
        toast.success("Shopeeアカウントを接続しました");
        router.replace("/dashboard", { scroll: false });
        await runBackgroundSync();
      } catch (e) {
        oauthRecoveryRef.current = false;
        toast.error(formatSafeFetchError(e));
        router.replace("/dashboard", { scroll: false });
      }
    })();
  }, [router, runBackgroundSync]);

  // 1) Load cached chats from MongoDB immediately. 2) Then sync from Shopee in the background
  // (does not block the first paint).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setSyncStatus("idle");
      setSyncError(null);
      try {
        const list = await fetchChats();
        if (!cancelled) setChats(list);
      } catch {
        if (!cancelled) toast.error("チャットの読み込みに失敗しました");
      } finally {
        if (!cancelled) setLoading(false);
      }
      if (cancelled) return;
      void runBackgroundSync();
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchChats, runBackgroundSync]);

  // 10分ごとに Shopee へ同期（ダッシュボードを開いている間のみ。タブが非表示ならスキップ）
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void runBackgroundSync();
    }, DASHBOARD_AUTO_SYNC_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [runBackgroundSync]);

  const handleSync = async () => {
    setManualSyncing(true);
    setSyncStatus("syncing");
    setSyncError(null);
    try {
      const data = await safeJsonFetch<SyncApiResponse>(
        "/api/shopee/sync",
        { method: "POST" },
        { timeoutMs: SYNC_FETCH_TIMEOUT_MS, label: "/api/shopee/sync" }
      );
      if (data.error) throw new Error(data.error);
      playSoundsForSyncDelta(data.results, playMessageSound, playOrderSound);
      dispatchShopNotificationsRefresh({
        newNotificationIdsTotal: sumNewNotificationIdsFromSyncResults(
          data.results
        ),
      });
      setSyncStatus("success");
      setLastSynced(new Date());
      toast.success("Shopeeから会話を同期しました");
      setChats(await fetchChats());
    } catch (error) {
      const msg = formatSafeFetchError(error);
      setSyncStatus("error");
      setSyncError(msg);
      toast.error(msg);
      console.warn("[dashboard] manual sync failed:", error);
    } finally {
      // ★ 必ずクリア (タイムアウト系で「同期中」表示が永遠に残るのを防ぐ)
      setManualSyncing(false);
    }
  };

  // チャットタイプ別の統計
  const buyerChats = chats.filter(c => c.type === "buyer");
  const notificationChats = chats.filter(c => c.type === "notification");
  const affiliateChats = chats.filter(c => c.type === "affiliate");

  const totalUnreadMessages = useMemo(
    () => chats.reduce((s, c) => s + Math.max(0, c.unread), 0),
    [chats]
  );
  const unreadConversationCount = useMemo(
    () => chats.filter((c) => c.unread > 0).length,
    [chats]
  );
  const chatsSortedUnreadFirst = useMemo(() => {
    return [...chats].sort((a, b) => {
      const ua = a.unread > 0 ? 1 : 0;
      const ub = b.unread > 0 ? 1 : 0;
      if (ua !== ub) return ub - ua;
      return 0;
    });
  }, [chats]);

  const dashboardRecentChats = useMemo(() => {
    const q = search.trim();
    const isSearching = Boolean(q);
    const filtered = isSearching
      ? chatsSortedUnreadFirst.filter((c) =>
          matchChatSearchQuery(search, {
            customer: c.customer,
            lastMessage: c.lastMessage,
            country: c.country,
            id: c.id,
            customer_id: c.customer_id,
          })
        )
      : chatsSortedUnreadFirst;
    // 検索時は最大20件、通常時は最近5件
    const limit = isSearching ? 20 : 5;
    return {
      items: filtered.slice(0, limit),
      total: filtered.length,
      isSearching,
      limit,
    };
  }, [chatsSortedUnreadFirst, search]);

  const goToFullSearch = useCallback(() => {
    const q = search.trim();
    if (!q) return;
    router.push(`/chats?q=${encodeURIComponent(q)}`);
  }, [router, search]);

  const stats = [
    { label: "バイヤーチャット", value: buyerChats.length, icon: ShoppingCart, color: "text-blue-600", bg: "bg-blue-50 border-blue-200" },
    { label: "Shopee通知", value: notificationChats.length, icon: Bell, color: "text-amber-600", bg: "bg-amber-50 border-amber-200" },
    { label: "アフィリエイト", value: affiliateChats.length, icon: TrendingUp, color: "text-purple-600", bg: "bg-purple-50 border-purple-200" },
    { label: "未読メッセージ", value: totalUnreadMessages, icon: AlertCircle, color: "text-red-600", bg: "bg-red-50 border-red-200" },
  ];

  // 同期中の経過秒数を 1 秒間隔で再計算するためのティック (UI 表示用)。
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!syncStartedAt) return;
    const id = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [syncStartedAt]);
  const syncElapsedSec = syncStartedAt
    ? Math.max(0, Math.floor((Date.now() - syncStartedAt.getTime()) / 1000))
    : 0;

  return (
    <div className="space-y-5 animate-fade-in">
      {/* ページタイトル */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">ダッシュボード</h1>
          <div className="flex items-center gap-2 mt-1">
            {(syncStatus === "syncing" || backgroundSyncing || manualSyncing) && (
              <span
                className={
                  syncElapsedSec >= 30
                    ? "flex items-center gap-1 text-xs text-amber-600"
                    : "flex items-center gap-1 text-xs text-blue-500"
                }
              >
                <Loader2 size={12} className="animate-spin" />
                {manualSyncing
                  ? "Shopeeから同期中..."
                  : "バックグラウンドでShopee同期中..."}
                {syncStartedAt && (
                  <span className="ml-1 tabular-nums">
                    ({syncElapsedSec}秒
                    {syncElapsedSec >= 30 && " — 応答待ちが長引いています"})
                  </span>
                )}
              </span>
            )}
            {syncStatus === "success" && lastSynced && (
              <span className="flex items-center gap-1 text-xs text-green-600">
                <CheckCircle2 size={12} />
                最終同期: {lastSynced.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
            {syncStatus === "error" && (
              <span className="flex items-center gap-1 text-xs text-red-500">
                <XCircle size={12} />
                {syncError ?? "同期エラー"}
              </span>
            )}
            {syncStatus === "idle" &&
              !backgroundSyncing &&
              !manualSyncing && (
              <p className="text-sm text-gray-500">全体状況の概要を確認</p>
            )}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleSync}
          disabled={manualSyncing || loading}
          className="h-10 gap-2 rounded-xl border-gray-200 hover:bg-gray-50"
        >
          {manualSyncing ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              同期中
            </>
          ) : (
            <>
              <RefreshCw size={16} />
              データ更新
            </>
          )}
        </Button>
      </div>

      <div className="relative max-w-2xl">
        <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        <Input
          type="search"
          placeholder="顧客名・メッセージ・国・会話IDで検索（Enterで全件検索へ）"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              goToFullSearch();
            }
          }}
          className="pl-10 h-11 rounded-xl border-gray-200 bg-white shadow-sm"
          aria-label="チャット検索"
        />
      </div>

      {totalUnreadMessages > 0 && (
        <div className="rounded-2xl border border-red-200 bg-red-50/90 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2 text-red-950 min-w-0">
            <AlertCircle className="shrink-0 mt-0.5" size={20} />
            <div>
              <p className="font-bold text-sm">未読メッセージがあります</p>
              <p className="text-xs text-red-900/90 mt-0.5">
                未読会話 {unreadConversationCount} 件 · 未読合計 {totalUnreadMessages} 通（一覧では未読が先頭です）
              </p>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            className="shrink-0 bg-red-600 hover:bg-red-700 text-white"
            onClick={() => router.push("/chats?unread_only=1")}
          >
            未読一覧へ
          </Button>
        </div>
      )}

      {/* チャットタイプ別統計カード */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map(({ label, value, icon: Icon, color, bg }, index) => (
          <div 
            key={label} 
            className="relative overflow-hidden rounded-2xl border bg-white shadow-sm hover:shadow-md transition-all duration-200 group cursor-pointer"
            style={{ animationDelay: `${index * 50}ms` }}
            onClick={() => {
              if (label === "Shopee通知") {
                router.push("/chats?focus=notifications");
                return;
              }
              if (label === "未読メッセージ") {
                router.push("/chats?unread_only=1");
                return;
              }
              if (label === "バイヤーチャット" || label === "アフィリエイト") {
                router.push("/chats");
                return;
              }
              router.push("/chats");
            }}
          >
            <div className="p-5 flex flex-col">
              <div className="flex items-center justify-between mb-3">
                <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center", bg)}>
                  <Icon size={22} className={color} />
                </div>
                <div className="text-right">
                  <p className={cn("text-3xl font-bold", color)}>{value}</p>
                </div>
              </div>
              <p className="text-gray-600 text-sm font-medium">{label}</p>
            </div>
            <div className="absolute inset-0 bg-gradient-to-br from-transparent via-transparent to-gray-50/50 opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        ))}
      </div>

      {/* 国別の状況サマリー */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <MessageSquare size={18} className="text-gray-600" />
            <h2 className="text-gray-900 font-bold text-base">国別サマリー</h2>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {COUNTRIES.filter(c => c !== "全て").map((country) => {
            const countryChats = chats.filter(c => c.country === country);
            const unreadCount = countryChats.filter(c => c.unread > 0).length;
            const countryUnreadMsgs = countryChats.reduce(
              (s, c) => s + Math.max(0, c.unread),
              0
            );
            return (
              <button
                key={country}
                onClick={() =>
                  router.push(
                    unreadCount > 0
                      ? `/chats?country=${country}&unread_only=1`
                      : `/chats?country=${country}`
                  )
                }
                className="p-4 rounded-xl border-2 border-gray-200 hover:border-primary hover:bg-primary/5 transition-all group"
              >
                <div className="text-center">
                  <div className="w-10 h-10 mx-auto mb-2 rounded-lg bg-gradient-to-br from-primary to-primary-dark flex items-center justify-center shadow-md group-hover:scale-110 transition-transform">
                    <span className="text-white text-xs font-bold">{country}</span>
                  </div>
                  <p className="text-2xl font-bold text-gray-900">{countryChats.length}</p>
                  <p className="text-xs text-gray-500 mt-1">チャット</p>
                  {/* Fixed height area for unread badge */}
                  <div className="mt-2 h-6 flex items-center justify-center">
                    {unreadCount > 0 ? (
                      <div className="inline-flex flex-col items-center gap-0.5 px-2 py-0.5 rounded-lg bg-red-50 border border-red-200">
                        <span className="text-xs font-bold text-red-700 tabular-nums">
                          {countryUnreadMsgs} 通未読
                        </span>
                        <span className="text-[10px] text-red-600/90">{unreadCount} 会話</span>
                      </div>
                    ) : (
                      <div className="h-6"></div>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 最近のチャット / 検索結果 */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between bg-gradient-to-r from-gray-50 to-white">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              {dashboardRecentChats.isSearching
                ? <Search size={16} className="text-primary" />
                : <Clock size={16} className="text-primary" />}
            </div>
            <div className="flex flex-col">
              <p className="text-gray-900 font-bold text-base">
                {dashboardRecentChats.isSearching ? "検索結果" : "最近のチャット"}
              </p>
              {dashboardRecentChats.isSearching && (
                <p className="text-xs text-gray-500 mt-0.5">
                  {dashboardRecentChats.total > dashboardRecentChats.limit
                    ? `${dashboardRecentChats.total}件ヒット（先頭${dashboardRecentChats.limit}件を表示）`
                    : `${dashboardRecentChats.total}件ヒット`}
                </p>
              )}
            </div>
          </div>
          {dashboardRecentChats.isSearching ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2 rounded-xl border-gray-200"
              onClick={goToFullSearch}
            >
              全件検索へ
              <ChevronRight size={14} />
            </Button>
          ) : (
            <Link href="/chats">
              <Button variant="outline" size="sm" className="gap-2 rounded-xl border-gray-200">
                すべて見る
                <ChevronRight size={14} />
              </Button>
            </Link>
          )}
        </div>
        <div className="divide-y divide-gray-100">
          {loading ? (
            <div className="py-16 text-center">
              <Loader2 className="animate-spin text-primary mx-auto mb-3" size={36} />
              <p className="text-gray-500 text-sm">読み込み中...</p>
            </div>
          ) : chats.length === 0 ? (
            <div className="py-16 text-center text-gray-500 text-sm px-4">
              <div className="w-16 h-16 rounded-2xl bg-gray-100 mx-auto mb-4 flex items-center justify-center">
                {syncStatus === "error"
                  ? <XCircle size={32} className="text-red-400" />
                  : <MessageSquare size={32} className="text-gray-300" />}
              </div>
              <div className="space-y-3">
                {syncStatus === "error" ? (
                  <>
                    <p className="text-gray-900 font-semibold">Shopee同期エラー</p>
                    <p className="text-gray-500 text-xs">{syncError}</p>
                    <Button variant="outline" size="sm" onClick={handleSync} className="gap-2 rounded-xl border-gray-200">
                      <RefreshCw size={16} />
                      再同期
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="text-gray-900 font-semibold">チャットがありません</p>
                    <p className="text-gray-500 text-xs mb-4">Shopeeストアを接続して会話を同期してください</p>
                    <Link href="/settings">
                      <Button variant="outline" size="sm" className="gap-2 rounded-xl border-gray-200">
                        <Settings size={16} />
                        設定でストアを接続
                      </Button>
                    </Link>
                  </>
                )}
              </div>
            </div>
          ) : dashboardRecentChats.items.length === 0 && search.trim() ? (
            <div className="py-12 text-center text-gray-500 text-sm px-4">
              <Search className="mx-auto mb-3 text-gray-300" size={36} />
              <p className="text-gray-900 font-medium">検索に一致する会話がありません</p>
              <p className="text-xs mt-1 text-gray-500">条件を変えるか、チャット一覧で詳しく探してください</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-4 rounded-xl border-gray-200"
                onClick={() => router.push("/chats")}
              >
                チャット一覧へ
              </Button>
            </div>
          ) : (
            // 通常時: 未読優先で最近5件。検索時: 条件一致から最大20件（上限超過は「全件検索へ」で /chats?q=... へ）
            dashboardRecentChats.items.map((chat, index) => {
              const typeConfig = chatTypeConfig[chat.type || "buyer"];
              const TypeIcon = typeConfig.icon;
              return (
                <div
                  key={chat.id}
                  onClick={() => router.push(`/chats/${chat.id}`)}
                  className={cn(
                    "flex items-center gap-4 px-5 py-4 hover:bg-gray-50 cursor-pointer transition-all group",
                    chat.unread > 0 && "bg-red-50/40 border-l-4 border-l-red-500"
                  )}
                  style={{ animationDelay: `${index * 30}ms` }}
                >
                  {/* Country Badge */}
                  <div className="flex-shrink-0 w-11 h-11 bg-gradient-to-br from-primary to-primary-dark rounded-2xl flex items-center justify-center shadow-md">
                    <span className="text-white text-sm font-bold">{chat.country}</span>
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-gray-900 font-semibold text-sm">{chat.customer}</span>
                      {/* チャットタイプバッジ */}
                      <div className={cn(
                        "flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium",
                        typeConfig.bg, typeConfig.color
                      )}>
                        <TypeIcon size={12} />
                        <span>{typeConfig.label}</span>
                      </div>
                      {chat.unread > 0 && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-red-600 text-white font-bold tabular-nums">
                          未読 {chat.unread}
                        </span>
                      )}
                      <StaffSendKindPill kind={chat.last_staff_send_kind} />
                    </div>
                    <p className="text-gray-500 text-xs truncate">{chat.lastMessage}</p>
                  </div>

                  {/* Time */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-gray-400 text-xs font-medium">{chat.time}</span>
                  </div>

                  <ChevronRight size={18} className="text-gray-300 group-hover:text-primary transition-colors flex-shrink-0" />
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

