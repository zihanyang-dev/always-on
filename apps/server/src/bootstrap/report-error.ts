import { inspect } from 'node:util';

/** Reports startup and teardown failures without losing causes or suppressed cleanup errors. */
export function reportError(error: unknown): void {
  // Resource scopes can fail during both execution and disposal; neither failure may disappear.
  if (error instanceof SuppressedError) {
    reportError(error.error);
    reportError(error.suppressed);

    return;
  }

  console.error(inspect(error, { depth: null, colors: process.stderr.isTTY }));
}
