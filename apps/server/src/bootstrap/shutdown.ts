/** Owns termination listeners for a single process lifetime. */
export interface Shutdown extends Disposable {
  readonly wait: Promise<void>;
}

/** Waits for SIGINT or SIGTERM and removes both listeners on disposal. */
export function observeShutdown(): Shutdown {
  const { promise: wait, resolve } = Promise.withResolvers<void>();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return { wait, [Symbol.dispose]: dispose };

  function stop() {
    // Process signal payloads must not become values of the void completion promise.
    resolve();
  }

  function dispose() {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
