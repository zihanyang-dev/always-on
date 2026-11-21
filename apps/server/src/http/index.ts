import type { IncomingMessage } from 'node:http';
import type { Context, ErrorHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { ClientErrorStatusCode, ServerErrorStatusCode } from 'hono/utils/http-status';

export { observeHttpRequests } from './observe-requests.ts';

export type HttpEnv = { Bindings: { incoming?: IncomingMessage } };

export function errorResponse(
  ctx: Context,
  status: ClientErrorStatusCode | ServerErrorStatusCode,
  error: string,
): Response {
  return ctx.json({ error }, status);
}

export function invalidInput(result: { success: boolean }, ctx: Context): Response | undefined {
  if (!result.success) return errorResponse(ctx, 400, 'invalid_input');
}

export const limitApiBody = bodyLimit({
  maxSize: 16_384,
  onError: (ctx) => errorResponse(ctx, 413, 'request_too_large'),
});

export function httpErrorHandler(reportError: (error: Error) => void): ErrorHandler<HttpEnv> {
  return (error, ctx) => {
    if (error instanceof HTTPException && error.status < 500) {
      if (error.status === 400 && !error.res) return errorResponse(ctx, 400, 'invalid_input');

      return error.getResponse();
    }

    reportError(error);
    return errorResponse(ctx, 500, 'internal_error');
  };
}
