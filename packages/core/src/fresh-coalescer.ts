/**
 * Coalesces concurrent calls to an expensive read while guaranteeing freshness:
 * every caller receives the result of a run that started after its call, and at
 * most one run executes at a time. Callers arriving during a run share a single
 * follow-up run instead of receiving state that may predate their own writes.
 */
export function coalesceFresh<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | undefined;
  let queued: Promise<T> | undefined;
  const start = (): Promise<T> => {
    const current = run().finally(() => {
      if (inFlight === current) inFlight = undefined;
    });
    inFlight = current;
    return current;
  };
  return () => {
    if (queued) return queued;
    if (!inFlight) return start();
    queued = inFlight
      .catch(() => undefined)
      .then(() => {
        queued = undefined;
        return start();
      });
    return queued;
  };
}
