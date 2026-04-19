import { ObjectId } from "mongodb";

/**
 * タスク管理機能 — ドキュメント型とシリアライザ
 * コレクション: `tasks`
 */
export type TaskDoc = {
  _id: ObjectId;
  /** タスク名（必須） */
  title: string;
  /** 内容（任意・複数行可） */
  content: string;
  /** 担当者 = staff_members._id の文字列の配列 */
  assignees: string[];
  /** 期限（日時）。未指定なら null */
  due_date: Date | null;
  completed: boolean;
  completed_at: Date | null;
  /** 完了操作者の email（監査用、未完了時は null） */
  completed_by: string | null;
  /** 関連会話ID（shopee_conversations.id 相当）。会話画面から作成時にセット */
  conversation_id: string | null;
  /** 関連バイヤーID（customer_id 相当） */
  buyer_id: string | null;
  /** SG/MY/PH/TW/TH/VN/BR など */
  country: string | null;
  created_at: Date;
  updated_at: Date;
  /** 作成者の email */
  created_by: string;
};

/** クライアント送出用の serialize 結果 */
export type TaskApi = {
  id: string;
  title: string;
  content: string;
  assignees: string[];
  due_date: string | null;
  completed: boolean;
  completed_at: string | null;
  completed_by: string | null;
  conversation_id: string | null;
  buyer_id: string | null;
  country: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
};

export function serializeTask(doc: TaskDoc): TaskApi {
  return {
    id: doc._id.toString(),
    title: doc.title,
    content: doc.content,
    assignees: Array.isArray(doc.assignees) ? doc.assignees : [],
    due_date: doc.due_date ? doc.due_date.toISOString() : null,
    completed: Boolean(doc.completed),
    completed_at: doc.completed_at ? doc.completed_at.toISOString() : null,
    completed_by: doc.completed_by ?? null,
    conversation_id: doc.conversation_id ?? null,
    buyer_id: doc.buyer_id ?? null,
    country: doc.country ?? null,
    created_at: doc.created_at.toISOString(),
    updated_at: doc.updated_at.toISOString(),
    created_by: doc.created_by,
  };
}

/** body から Date | null を安全に取り出す */
export function parseOptionalDate(input: unknown): Date | null {
  if (input == null || input === "") return null;
  if (input instanceof Date) return isNaN(input.getTime()) ? null : input;
  if (typeof input === "string" || typeof input === "number") {
    const d = new Date(input);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** 文字列配列を正規化（非文字列を除去・trim・重複除去） */
export function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const set = new Set<string>();
  for (const v of input) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t) set.add(t);
  }
  return [...set];
}
