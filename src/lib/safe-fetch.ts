/**
 * safe-fetch.ts — フロント側 fetch の防御層
 *
 * 旧コードの問題:
 *   const res = await fetch(url, init);
 *   const data = (await res.json()) as ...;   // ← 空 body / HTML を json() すると
 *                                              //    "Unexpected token 'A'..." で死ぬ
 *   if (!res.ok) throw new Error(data.error || "...");  // ← 死んだ後で評価される
 *
 * さらに、fetch そのものが resolve しない (Vercel edge timeout / CDN つまり等)
 * 場合、UI のローディング表示が永遠に残る事故が発生する (5 分以上「同期中」表示)。
 *
 * このヘルパは:
 *   1. AbortController で必ずタイムアウトを切る (Vercel Pro Function は最大 60s)
 *   2. res.ok を json parse 前に検査する
 *   3. content-type が application/json でなければ HTML 等として扱う
 *   4. エラー種別を投げ分け、UI 側で適切なメッセージを出せるようにする
 *
 * 設計方針: 失敗を「無音で握り潰さない」「永遠に待たない」。
 */

export type SafeFetchOptions = {
  /** ms。指定 ms で AbortController が発火する。デフォルト 60000 (=60s) */
  timeoutMs?: number;
  /** デバッグ用ラベル。エラー文に含める */
  label?: string;
};

export class TimeoutError extends Error {
  readonly kind = "timeout" as const;
  constructor(label: string, ms: number) {
    super(`${label} がタイムアウト (${Math.round(ms / 1000)}秒)`);
    this.name = "TimeoutError";
  }
}

export class HttpError extends Error {
  readonly kind = "http" as const;
  constructor(
    label: string,
    public status: number,
    public bodySnippet: string
  ) {
    super(`${label} HTTP ${status}: ${bodySnippet.slice(0, 200)}`);
    this.name = "HttpError";
  }
}

export class NonJsonResponseError extends Error {
  readonly kind = "non_json" as const;
  constructor(
    label: string,
    public contentType: string | null,
    public bodySnippet: string
  ) {
    super(
      `${label} が JSON を返していません (content-type=${contentType ?? "<none>"})`
    );
    this.name = "NonJsonResponseError";
  }
}

export class NetworkError extends Error {
  readonly kind = "network" as const;
  constructor(label: string, cause: unknown) {
    super(
      `${label} ネットワークエラー: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "NetworkError";
  }
}

export type SafeFetchError =
  | TimeoutError
  | HttpError
  | NonJsonResponseError
  | NetworkError;

/**
 * fetch + JSON parse を 1 関数にまとめた防御版。
 *
 * - 必ず AbortController でタイムアウトを切る
 * - res.ok / content-type を確認
 * - 失敗種別を型付きエラーで投げる
 *
 * 戻り値の型は呼び出し側でジェネリクスで指定する。
 */
export async function safeJsonFetch<T = unknown>(
  url: string,
  init: RequestInit = {},
  opts: SafeFetchOptions = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const label = opts.label ?? url;

  const controller = new AbortController();
  // 既に呼び出し側で AbortSignal が渡されているなら両者を結ぶ
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else
      init.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    // AbortController による中断はタイムアウト扱い
    if (
      e instanceof DOMException && e.name === "AbortError"
    ) {
      throw new TimeoutError(label, timeoutMs);
    }
    throw new NetworkError(label, e);
  }
  clearTimeout(timer);

  // body は一度だけ読めるので、まず content-type を見て分岐
  const contentType = res.headers.get("content-type");
  const isJsonContentType = !!contentType && /json/i.test(contentType);

  if (!res.ok) {
    // エラー応答: content-type が JSON でも HTML でも、まず text として読み snippet にする
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      bodyText = "<body read failed>";
    }
    throw new HttpError(label, res.status, bodyText);
  }

  if (!isJsonContentType) {
    // 200 だが JSON ではない (Vercel/Next.js のエラーページ HTML 等)
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      bodyText = "<body read failed>";
    }
    throw new NonJsonResponseError(label, contentType, bodyText);
  }

  try {
    return (await res.json()) as T;
  } catch (e) {
    // ここに来るのは「content-type は JSON だが body が壊れている」異常系
    throw new NonJsonResponseError(
      label,
      contentType,
      e instanceof Error ? e.message : String(e)
    );
  }
}

/**
 * UI 表示向けにエラーを「ユーザに見せる短文」に整形する。
 * 種別ごとに日本語で意味のある文に変換する。
 */
export function formatSafeFetchError(e: unknown): string {
  if (e instanceof TimeoutError) {
    return `${e.message}。バックエンドで処理が継続している可能性があります。少し待ってから再度お試しください。`;
  }
  if (e instanceof HttpError) {
    return `サーバーエラー (HTTP ${e.status})。時間を置いて再度お試しください。`;
  }
  if (e instanceof NonJsonResponseError) {
    return `応答が解釈できませんでした。Vercel 側で一時的なエラーが起きている可能性があります。`;
  }
  if (e instanceof NetworkError) {
    return `ネットワーク接続を確認してください。`;
  }
  if (e instanceof Error) return e.message;
  return "不明なエラー";
}
