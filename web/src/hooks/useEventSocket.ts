import { useEffect, useRef, useState } from "react";

export type ConnState = "connecting" | "open" | "closed";

/**
 * Reconnecting WebSocket feed. `extract` turns one server message into zero or
 * more items; items are batched (80 ms) and capped at `max`.
 */
export function useEventSocket<T>(url: string | null, extract: (msg: unknown) => T[] | null, max = 3000) {
  const [items, setItems] = useState<T[]>([]);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const extractRef = useRef(extract);
  extractRef.current = extract;

  useEffect(() => {
    if (!url) return;
    setItems([]);
    setConn("connecting");
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let pending: T[] = [];
    let flush: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      ws = new WebSocket(url);
      ws.onopen = () => setConn("open");
      ws.onmessage = (ev) => {
        if (pausedRef.current) return;
        let batch: T[] | null = null;
        try {
          batch = extractRef.current(JSON.parse(ev.data as string));
        } catch {
          return;
        }
        if (!batch?.length) return;
        pending.push(...batch);
        flush ??= setTimeout(() => {
          flush = null;
          const b = pending;
          pending = [];
          setItems((prev) => {
            const next = prev.concat(b);
            return next.length > max ? next.slice(next.length - max) : next;
          });
        }, 80);
      };
      ws.onclose = () => {
        setConn("closed");
        if (!closed) retry = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (flush) clearTimeout(flush);
      ws?.close();
    };
  }, [url, max]);

  return { items, conn, paused, setPaused, clear: () => setItems([]) };
}
