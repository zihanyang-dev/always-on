type ErrorDiagnostic = {
  readonly type: string;
  readonly code?: string;
  readonly location?: string;
  readonly message?: string;
  readonly causes?: readonly ErrorDiagnostic[];
};

const ERROR_CODE = /^(?:[0-9A-Z]{5}|E[A-Z]{2,20}|ERR_[A-Z_]{1,50})$/;
const SOURCE_LOCATION =
  /^ {4}at .*?((?:apps\/server|packages\/agent-runtime)\/(?:src|dist)\/[a-zA-Z0-9_/-]+\.[jt]s:\d+:\d+)\)?$/m;
const MAX_CAUSE_DEPTH = 5;

/** Configuration diagnostics contain only names of settings and application-authored text. */
export class ConfigurationError extends Error {}

/** Preserves the error structure without forwarding opaque SDK messages or database parameters. */
export function describeError(error: unknown): ErrorDiagnostic {
  return describe(error, 0);
}

/** Uses the same safe diagnostic for startup and shutdown as the running API and Worker. */
export function reportError(error: unknown): void {
  console.error(JSON.stringify(describeError(error)));
}

function describe(error: unknown, depth: number): ErrorDiagnostic {
  if (!(error instanceof Error)) return { type: 'NonError' };

  const code =
    'code' in error && typeof error.code === 'string' && ERROR_CODE.test(error.code)
      ? error.code
      : undefined;
  const location = error.stack?.match(SOURCE_LOCATION)?.[1];
  // Bound traversal also handles cycles in arbitrary dependency failures.
  const causes =
    depth < MAX_CAUSE_DEPTH ? getCauses(error).map((cause) => describe(cause, depth + 1)) : [];

  return {
    type: error.constructor.name,
    ...(code ? { code } : {}),
    ...(location ? { location } : {}),
    ...(error instanceof ConfigurationError ? { message: error.message } : {}),
    ...(causes.length > 0 ? { causes } : {}),
  };
}

function getCauses(error: Error): readonly unknown[] {
  if (error instanceof SuppressedError) return [error.error, error.suppressed];
  if (error instanceof AggregateError) return error.errors.slice(0, 5);

  return error.cause === undefined ? [] : [error.cause];
}
