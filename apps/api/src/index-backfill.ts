/** Retain bounded progress so a serverless restart can resume historical logs. */
export async function backfillRanges(options: {
  from: bigint;
  to: bigint;
  store: (from: bigint, to: bigint) => Promise<void>;
  checkpoint: (next: bigint, complete: boolean) => Promise<void>;
}) {
  let next = options.from;
  let ranges = 0;
  while (next <= options.to) {
    const end = next + 99n < options.to ? next + 99n : options.to;
    await options.store(next, end);
    next = end + 1n;
    if (++ranges % 100 === 0) await options.checkpoint(next, next > options.to);
  }
  await options.checkpoint(next, true);
}

/** Fetch concurrently, apply in block order, and checkpoint only complete batches. */
export async function replayLogRanges<T>(options: {
  from: bigint;
  to: bigint;
  range: bigint;
  fetch: (from: bigint, to: bigint) => Promise<T>;
  store: (
    value: T,
    from: bigint,
    to: bigint,
    advance: boolean,
  ) => Promise<void>;
  checkpoint: () => Promise<void>;
}) {
  let from = options.from,
    ranges = 0;
  while (from <= options.to) {
    const batch: { from: bigint; to: bigint }[] = [];
    for (let count = 0; count < 10 && from <= options.to; count++) {
      const to =
        from + options.range - 1n < options.to
          ? from + options.range - 1n
          : options.to;
      batch.push({ from, to });
      from = to + 1n;
    }
    const values = await Promise.all(
      batch.map(({ from, to }) => options.fetch(from, to)),
    );
    for (const [index, bounds] of batch.entries())
      await options.store(
        values[index],
        bounds.from,
        bounds.to,
        index === batch.length - 1,
      );
    if ((ranges += batch.length) % 100 === 0) await options.checkpoint();
  }
}
