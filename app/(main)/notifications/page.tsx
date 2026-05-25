"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Bell, Loader2, ExternalLink, RefreshCw, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  type ShopCenterNotifItem,
  type ShopNotifCategory,
  SHOP_NOTIF_CATEGORY_LABELS,
  dedupeShopNotificationItems,
  inferShopNotificationCategory,
  parseShopNotificationPayload,
} from "@/lib/shopee-shop-notification-parse";

/** API 経由の JSON では Date が ISO 文字列になるため両方受け取る */
function formatNotifTime(d?: Date | string | number): string {
  if (d == null || d === "") return "";
  let date: Date;
  if (d instanceof Date) date = d;
  else if (typeof d === "number" && Number.isFinite(d))
    date = new Date(d > 1e12 ? d : d * 1000);
  else if (typeof d === "string") date = new Date(d);
  else return "";
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Shopee が返す <b>...</b> を太字レンダリング */
function renderNotifContent(html: string): ReactNode {
  if (!html) return null;
  const parts: ReactNode[] = [];
  let remaining = html;
  let key = 0;
  while (remaining.length) {
    const open = remaining.search(/<b>/i);
    if (open === -1) {
      parts.push(remaining);
      break;
    }
    if (open > 0) parts.push(remaining.slice(0, open));
    const afterOpen = remaining.slice(open + 3);
    const close = afterOpen.search(/<\/b>/i);
    if (close === -1) {
      parts.push(afterOpen);
      break;
    }
    parts.push(
      <strong key={`b-${key++}`} className="font-semibold text-gray-900">
        {afterOpen.slice(0, close)}
      </strong>
    );
    remaining = afterOpen.slice(close + 4);
  }
  return <>{parts}</>;
}

const ALL = "全て";

/** カテゴリチップの並び順（固定） */
const CATEGORY_ORDER: ShopNotifCategory[] = [
  "order",
  "rating",
  "return_refund",
  "performance",
  "balance",
  "listing",
  "other",
];

export default function NotificationsPage() {
  const [items, setItems] = useState<ShopCenterNotifItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [country, setCountry] = useState<string>(ALL);
  const [category, setCategory] = useState<ShopNotifCategory | "all">("all");

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/shopee/shop-notifications?page_size=50");
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(
          typeof json.error === "string" ? json.error : "通知の取得に失敗しました"
        );
      }
      let list: ShopCenterNotifItem[];
      if (json.multi_shop === true && Array.isArray(json.chapee_merged_items)) {
        list = dedupeShopNotificationItems(
          json.chapee_merged_items as ShopCenterNotifItem[]
        );
      } else {
        const parsed = parseShopNotificationPayload(json);
        const cc =
          typeof json.chapee_shop_country === "string"
            ? json.chapee_shop_country.toUpperCase()
            : undefined;
        list = dedupeShopNotificationItems(
          parsed.items.map((i) => (i.country || !cc ? i : { ...i, country: cc }))
        );
      }
      setItems(list);
    } catch (e) {
      setItems([]);
      setError(e instanceof Error ? e.message : "通知の取得に失敗しました");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 一覧に存在する国コード（チップ生成用） */
  const countries = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) if (i.country) set.add(i.country);
    return [ALL, ...Array.from(set).sort()];
  }, [items]);

  /** 一覧に存在するカテゴリ（チップ生成用、固定順） */
  const categories = useMemo(() => {
    const present = new Set<ShopNotifCategory>();
    for (const i of items) present.add(inferShopNotificationCategory(i));
    return CATEGORY_ORDER.filter((c) => present.has(c));
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((i) => {
      const matchCountry = country === ALL || i.country === country;
      const matchCategory =
        category === "all" || inferShopNotificationCategory(i) === category;
      return matchCountry && matchCategory;
    });
  }, [items, country, category]);

  return (
    <div className="space-y-5 animate-fade-in max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-center">
            <Bell size={18} className="text-amber-600" />
          </div>
          <div>
            <h2 className="text-gray-900 font-bold text-lg leading-tight">
              Shopee通知
            </h2>
            <p className="text-xs text-gray-500">
              Seller Center 通知（配送・注文・評価・返金など）
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load(true)}
          disabled={loading || refreshing}
          className="gap-2 rounded-xl"
        >
          {refreshing ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <RefreshCw size={16} />
          )}
          更新
        </Button>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 space-y-4">
        <div>
          <label className="text-gray-700 text-sm font-semibold mb-2 block">国</label>
          <div className="flex gap-2 flex-wrap">
            {countries.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCountry(c)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-sm font-medium transition-all border",
                  country === c
                    ? "bg-primary text-white border-primary"
                    : "bg-white text-gray-700 border-gray-200 hover:border-primary/50"
                )}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-gray-700 text-sm font-semibold mb-2 block">
            カテゴリ
          </label>
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setCategory("all")}
              className={cn(
                "px-3 py-1.5 rounded-lg text-sm font-medium transition-all border",
                category === "all"
                  ? "bg-primary text-white border-primary"
                  : "bg-white text-gray-700 border-gray-200 hover:border-primary/50"
              )}
            >
              すべて
            </button>
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-sm font-medium transition-all border",
                  category === c
                    ? "bg-amber-600 text-white border-amber-600"
                    : "bg-white text-gray-700 border-gray-200 hover:border-amber-300"
                )}
              >
                {SHOP_NOTIF_CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Summary */}
      <div className="text-sm text-gray-600">
        表示 {filtered.length} 件 / 全 {items.length} 件
      </div>

      {/* List */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="py-16 text-center text-gray-500">
            <Loader2 className="animate-spin inline-block mr-2" size={20} />
            読み込み中...
          </div>
        ) : error ? (
          <div className="py-12 text-center px-4">
            <AlertCircle className="mx-auto mb-3 text-red-400" size={32} />
            <p className="text-gray-900 font-medium">{error}</p>
            <p className="text-xs text-gray-500 mt-1">
              Shopee 連携とアプリ権限を確認してください
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load(true)}
              className="mt-4 rounded-xl gap-2"
            >
              <RefreshCw size={14} />
              再試行
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-gray-500 text-sm px-4">
            <Bell className="mx-auto mb-3 text-gray-300" size={32} />
            通知はありません
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {filtered.map((item) => {
              const cat = inferShopNotificationCategory(item);
              return (
                <li
                  key={`${item.shopId ?? 0}-${item.id}`}
                  className="px-4 py-3.5 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    {item.country && (
                      <span className="inline-flex items-center justify-center rounded-md px-1.5 py-0.5 text-[10px] font-bold bg-primary text-white">
                        {item.country}
                      </span>
                    )}
                    <span className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium bg-amber-50 text-amber-800 border border-amber-200">
                      {SHOP_NOTIF_CATEGORY_LABELS[cat]}
                    </span>
                    <span className="text-gray-900 font-medium text-sm">
                      {item.title}
                    </span>
                    {item.createdAt && (
                      <span className="text-[11px] text-gray-400 tabular-nums ml-auto">
                        {formatNotifTime(item.createdAt)}
                      </span>
                    )}
                  </div>
                  {item.content && (
                    <p className="text-xs text-gray-600 leading-relaxed [&_strong]:text-gray-900">
                      {renderNotifContent(item.content)}
                    </p>
                  )}
                  {item.url && (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary mt-2 hover:underline"
                    >
                      詳細を開く（Shopee）
                      <ExternalLink size={11} />
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
