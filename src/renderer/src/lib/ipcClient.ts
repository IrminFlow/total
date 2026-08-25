export async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const result = await window.total.invoke(channel, payload);
  if (!result.ok) throw new Error(result.error ?? "Unknown error");
  return result.data as T;
}

export async function cancellableCall<T>(
  channel: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return call<T>(channel, payload);
  if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
  const requestId = crypto.randomUUID();
  const pending = window.total.invoke(channel, {
    ...payload,
    __totalRequestId: requestId,
  });
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      void window.total.invoke("request:cancel", { requestId });
      reject(new DOMException("Request cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void pending.then((result) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) return;
      if (!result.ok) reject(new Error(result.error ?? "Unknown error"));
      else resolve(result.data as T);
    }, reject);
  });
}
