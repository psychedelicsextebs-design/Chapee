import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type HandlingStatus,
  HANDLING_STATUS_BADGE_STYLE,
  HANDLING_STATUS_LABELS,
} from "@/lib/handling-status";

/**
 * 対応ステータスのバッジ（会話一覧・ダッシュボードで共通）。
 *
 * auto_replied_pending（自動返信のみ・要対応）は、自動返信が「対応完了」に
 * 見えてフォロー漏れする事業リスクがあるため、 AlertCircle アイコンを添えて
 * 一覧でパッと「要対応」と分かるようにする。
 */
export function HandlingStatusBadge({
  status,
  className,
}: {
  status: HandlingStatus;
  className?: string;
}) {
  const needsFollowUp = status === "auto_replied_pending";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border leading-tight max-w-[200px]",
        HANDLING_STATUS_BADGE_STYLE[status],
        className
      )}
    >
      {needsFollowUp && <AlertCircle size={12} className="flex-shrink-0" />}
      {HANDLING_STATUS_LABELS[status]}
    </span>
  );
}
