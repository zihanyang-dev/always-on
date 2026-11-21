import { randomUUID } from 'node:crypto';
import {
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  type TextMapGetter,
} from '@opentelemetry/api';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { routePath } from 'hono/route';
import type { Observability } from '../infrastructure/index.ts';

const METHODS = new Set([
  'CONNECT',
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
  'TRACE',
]);

const HEADER_GETTER: TextMapGetter<Headers> = {
  keys: (headers) => Array.from(headers.keys()),
  get: (headers, key) => headers.get(key) ?? undefined,
};

type RequestDetails = { id: string; method: string; route: string | undefined };

/** Records one server span, log and duration sample for each request. */
export function observeHttpRequests({ logger, tracer, meter }: Observability): MiddlewareHandler {
  const duration = meter.createHistogram('http.server.request.duration', {
    description: 'Duration of HTTP server requests',
    unit: 's',
    advice: {
      explicitBucketBoundaries: [
        0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
      ],
    },
  });

  return observeRequest;

  function observeRequest(ctx: Context, next: Next) {
    const method = METHODS.has(ctx.req.method) ? ctx.req.method : '_OTHER';
    const template = routePath(ctx, -1);
    const route = template && template !== '*' && template !== '/*' ? template : undefined;
    const request = { id: randomUUID(), method, route };
    const parent = propagation.extract(ROOT_CONTEXT, ctx.req.raw.headers, HEADER_GETTER);

    ctx.header('X-Request-Id', request.id);
    return tracer.startActiveSpan(
      route ? `${method} ${route}` : method,
      { kind: SpanKind.SERVER },
      parent,
      run,
    );

    async function run(span: Span) {
      const startedAt = performance.now();
      try {
        await next();
      } finally {
        try {
          recordRequest(span, request, { status: ctx.res.status, startedAt });
        } finally {
          span.end();
        }
      }
    }
  }

  function recordRequest(
    span: Span,
    { id, method, route }: RequestDetails,
    { status, startedAt }: { status: number; startedAt: number },
  ) {
    const elapsed = performance.now() - startedAt;
    const failed = status >= 500;
    const attributes = {
      'http.request.method': method,
      'http.response.status_code': status,
      ...(route && { 'http.route': route }),
      ...(failed && { 'error.type': String(status) }),
    };

    span.setAttributes({ ...attributes, 'always_on.request.id': id });
    if (failed) span.setStatus({ code: SpanStatusCode.ERROR });

    duration.record(elapsed / 1000, attributes);
    logger[failed ? 'error' : 'info'](
      { request_id: id, method, route, status, duration_ms: elapsed },
      'http.request',
    );
  }
}
