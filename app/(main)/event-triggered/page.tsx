"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Info,
  Loader2,
  ShoppingBag,
  Truck,
  Star,
  type LucideIcon,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { SHOPEE_MARKET_CODES } from "@/lib/shopee-markets";

const COUNTRIES = [...SHOPEE_MARKET_CODES];

type EventTypeId =
  | "order_confirmed"
  | "tracking_registered"
  | "delivered_plus_3d";

const EVENT_TYPES: {
  id: EventTypeId;
  label: string;
  icon: LucideIcon;
  hint: string;
}[] = [
  {
    id: "order_confirmed",
    label: "購入後通知 (発送準備中)",
    icon: ShoppingBag,
    hint: "注文確定 (READY_TO_SHIP) のタイミングで発送準備中の案内を送信します",
  },
  {
    id: "tracking_registered",
    label: "発送後通知 (追跡番号)",
    icon: Truck,
    hint: "tracking_no が確定した時点で追跡番号の案内を送信します",
  },
  {
    id: "delivered_plus_3d",
    label: "到着後フォロー (レビュー依頼)",
    icon: Star,
    hint: "TO_CONFIRM_RECEIVE / COMPLETED のいずれか早い方で 1 度だけ送信します",
  },
];

type CountryCfg = { enabled: boolean; template_id: string };
type EventCfg = {
  enabled_global: boolean;
  countries: Record<string, CountryCfg>;
};
type Settings = Record<EventTypeId, EventCfg>;

type ReplyTemplateRow = {
  id: string;
  country: string;
  category: string;
  name: string;
  content: string;
  autoReply: boolean;
  langs: string[];
};

function filterTemplatesForCountry(
  rows: ReplyTemplateRow[],
  country: string
): ReplyTemplateRow[] {
  const list = rows.filter(
    (t) => t.country === "全て" || t.country === country
  );
  return [...list].sort((a, b) => {
    if (a.autoReply !== b.autoReply) return a.autoReply ? -1 : 1;
    return a.name.localeCompare(b.name, "ja");
  });
}

function defaultEventCfg(): EventCfg {
  return {
    enabled_global: false,
    countries: Object.fromEntries(
      COUNTRIES.map((c) => [c, { enabled: false, template_id: "" }])
    ),
  };
}

function defaultSettings(): Settings {
  return {
    order_confirmed: defaultEventCfg(),
    tracking_registered: defaultEventCfg(),
    delivered_plus_3d: defaultEventCfg(),
  };
}

function TriggerCard({
  label,
  Icon,
  hint,
  cfg,
  templates,
  onChange,
}: {
  label: string;
  Icon: LucideIcon;
  hint: string;
  cfg: EventCfg;
  templates: ReplyTemplateRow[];
  onChange: (next: EventCfg) => void;
}) {
  const [selectedCountry, setSelectedCountry] = useState<string>("SG");
  const countryCfg = cfg.countries[selectedCountry] ?? {
    enabled: false,
    template_id: "",
  };

  const templatesForCountry = useMemo(
    () => filterTemplatesForCountry(templates, selectedCountry),
    [templates, selectedCountry]
  );
  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === countryCfg.template_id),
    [templates, countryCfg.template_id]
  );

  const setGlobal = (v: boolean) => onChange({ ...cfg, enabled_global: v });

  /**
   * 国タブのクリック = 「選択中切替 + enabled の toggle」を同時に行う。
   * 既存 ON のタブをクリックすると OFF (選択中のまま)、 OFF のタブをクリックすると
   * ON + 選択中。 enabled の操作経路はこの 1 つだけにして UI を簡素化する。
   */
  const handleTabClick = (country: string) => {
    setSelectedCountry(country);
    const current = cfg.countries[country] ?? {
      enabled: false,
      template_id: "",
    };
    onChange({
      ...cfg,
      countries: {
        ...cfg.countries,
        [country]: { ...current, enabled: !current.enabled },
      },
    });
  };

  const setTemplate = (templateId: string) => {
    onChange({
      ...cfg,
      countries: {
        ...cfg.countries,
        [selectedCountry]: { ...countryCfg, template_id: templateId },
      },
    });
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden min-w-0">
      <div className="px-5 py-4 border-b border-gray-200 bg-gradient-to-r from-gray-50 to-white">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center flex-shrink-0">
              <Icon size={20} className="text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-gray-900 font-bold text-base truncate">
                {label}
              </p>
              <p className="text-gray-500 text-xs truncate">{hint}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <span className="text-gray-600 text-sm font-medium">
              {cfg.enabled_global ? "全国 ON" : "全国 OFF"}
            </span>
            <Switch
              checked={cfg.enabled_global}
              onCheckedChange={setGlobal}
            />
          </div>
        </div>
      </div>

      <div
        className={cn(
          "p-5 space-y-4 transition-opacity",
          !cfg.enabled_global && "opacity-50 pointer-events-none"
        )}
      >
        {/* 国タブ — クリックで ON/OFF + 選択中切替 */}
        <div className="grid grid-cols-7 gap-2">
          {COUNTRIES.map((country) => {
            const c = cfg.countries[country];
            const isSelected = selectedCountry === country;
            const isOn = Boolean(c?.enabled);
            return (
              <button
                key={country}
                type="button"
                onClick={() => handleTabClick(country)}
                title={`クリックで ${isOn ? "OFF" : "ON"} に切り替え`}
                className={cn(
                  "rounded-xl p-3 border-2 transition-all min-h-[60px] flex flex-col items-center justify-center gap-1",
                  isOn
                    ? "bg-primary border-primary shadow-md"
                    : "bg-white border-gray-200 hover:border-primary/50",
                  isSelected && "ring-2 ring-primary/60 ring-offset-1"
                )}
              >
                <p
                  className={cn(
                    "font-bold text-sm",
                    isOn ? "text-white" : "text-gray-900"
                  )}
                >
                  {country}
                </p>
                <span
                  className={cn(
                    "text-[10px] font-bold tracking-wide",
                    isOn ? "text-white/95" : "text-gray-500"
                  )}
                >
                  {isOn ? "ON" : "OFF"}
                </span>
              </button>
            );
          })}
        </div>

        <p className="text-[11px] text-gray-500 text-center">
          タブをクリックすると ON / OFF を切り替えます
        </p>

        {/* 選択中の国のテンプレート設定 */}
        <div className="rounded-xl border border-gray-100 bg-gray-50 p-4 space-y-3">
          <p className="text-sm text-gray-700">
            <span className="text-gray-500">※ 選択中: </span>
            <span className="font-bold text-gray-900">{selectedCountry}</span>
            <span
              className={cn(
                "ml-2 text-xs font-semibold",
                countryCfg.enabled ? "text-emerald-600" : "text-gray-400"
              )}
            >
              ({countryCfg.enabled ? "ON / 送信対象" : "OFF / 送信されません"})
            </span>
          </p>

          {templatesForCountry.length === 0 ? (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              {selectedCountry}{" "}
              向けのテンプレートがありません。テンプレート画面で
              {selectedCountry} または「全て」のテンプレートを追加してください。
            </p>
          ) : (
            <>
              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <span className="text-sm text-gray-700 font-medium whitespace-nowrap">
                  使用テンプレート:
                </span>
                <select
                  value={countryCfg.template_id}
                  onChange={(e) => setTemplate(e.target.value)}
                  className="flex-1 rounded-xl border-2 border-gray-200 bg-white px-4 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                >
                  <option value="">— 未設定 (送信しない) —</option>
                  {templatesForCountry.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.autoReply ? "★ " : ""}
                      {t.name}（{t.category} / {t.country}）
                    </option>
                  ))}
                </select>
              </div>
              {selectedTemplate && (
                <div className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700 whitespace-pre-wrap max-h-32 overflow-y-auto">
                  {selectedTemplate.content}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function EventTriggeredPage() {
  const [templates, setTemplates] = useState<ReplyTemplateRow[]>([]);
  const [settings, setSettings] = useState<Settings>(() => defaultSettings());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [tplRes, stRes] = await Promise.all([
        fetch("/api/reply-templates"),
        fetch("/api/settings/event-triggered"),
      ]);
      if (!tplRes.ok) throw new Error("templates");
      const tplData = (await tplRes.json()) as {
        templates?: ReplyTemplateRow[];
      };
      setTemplates(tplData.templates ?? []);

      if (stRes.ok) {
        const stData = (await stRes.json()) as {
          triggers?: Partial<Record<EventTypeId, EventCfg>>;
        };
        const merged: Settings = defaultSettings();
        for (const et of EVENT_TYPES) {
          const incoming = stData.triggers?.[et.id];
          if (!incoming) continue;
          const countries: Record<string, CountryCfg> = {};
          for (const c of COUNTRIES) {
            const v = incoming.countries?.[c];
            countries[c] = v
              ? {
                  enabled: Boolean(v.enabled),
                  template_id:
                    typeof v.template_id === "string" ? v.template_id : "",
                }
              : { enabled: false, template_id: "" };
          }
          merged[et.id] = {
            enabled_global: Boolean(incoming.enabled_global),
            countries,
          };
        }
        setSettings(merged);
      } else if (stRes.status === 401) {
        toast.error("ログインが必要です");
      }
    } catch {
      toast.error("設定の読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const updateTrigger = (id: EventTypeId, next: EventCfg) => {
    setSettings((prev) => ({ ...prev, [id]: next }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/event-triggered", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triggers: settings }),
      });
      if (!res.ok) {
        if (res.status === 401) {
          toast.error("ログインが必要です");
          return;
        }
        throw new Error();
      }
      toast.success("保存しました");
    } catch {
      toast.error("保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh] gap-2 text-muted-foreground">
        <Loader2 className="animate-spin size-6" />
        <span className="text-sm">読み込み中…</span>
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-fade-in max-w-6xl w-full min-w-0">
      <div className="min-w-0">
        <h2 className="text-foreground font-bold text-lg">イベント通知設定</h2>
        <p className="text-muted-foreground text-sm mt-0.5">
          注文ライフサイクル (購入 / 発送 / 到着) のタイミングでテンプレート本文を自動送信します。
          <br />
          テンプレート未設定の (event_type, country) 組み合わせは送信されません。
        </p>
      </div>

      <div className="flex gap-3 p-4 bg-blue-50 border border-blue-200 rounded-xl text-sm">
        <Info size={18} className="text-blue-600 flex-shrink-0 mt-0.5" />
        <p className="text-blue-900 text-xs leading-relaxed">
          バイヤー無返答 → 時限テンプレ送信は「自動返信設定」画面で別管理です。ここでは Shopee の注文 Push (code 3 / 4) に基づいて発火するイベント駆動通知のみを設定します。
        </p>
      </div>

      <div className="space-y-4">
        {EVENT_TYPES.map((e) => (
          <TriggerCard
            key={e.id}
            label={e.label}
            Icon={e.icon}
            hint={e.hint}
            cfg={settings[e.id]}
            templates={templates}
            onChange={(next) => updateTrigger(e.id, next)}
          />
        ))}
      </div>

      <div className="flex justify-end pb-4">
        <Button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-xl px-6"
        >
          {saving ? (
            <>
              <Loader2 className="animate-spin size-4 mr-2" />
              保存中…
            </>
          ) : (
            "設定を保存"
          )}
        </Button>
      </div>
    </div>
  );
}
