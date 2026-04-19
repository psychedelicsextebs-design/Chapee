/**
 * タスク変更通知イベント
 * ヘッダーのバッジや、別パネルのタスク一覧が即時再取得するための簡易バス。
 */

const EVENT_NAME = "chapee:tasks-changed";

export function dispatchTasksChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

export function subscribeTasksChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => listener();
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
