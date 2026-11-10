/** Discard responses started under a previous login, including pending shared refreshes. */
export function createSessionRefresh<T>(fetchData: () => Promise<T>, apply: (data: T) => void) {
  let generation = 0;
  let pending: Promise<void> | null = null;
  function invalidate() { generation++; pending = null; }
  function refresh(force = false): Promise<void> {
    if (force) invalidate();
    if (pending) return pending;
    const started = generation;
    const task = Promise.resolve().then(fetchData).then(data => {
      if (generation === started) apply(data);
    }).finally(() => { if (pending === task) pending = null; });
    pending = task;
    return task;
  }
  return { refresh, invalidate };
}
