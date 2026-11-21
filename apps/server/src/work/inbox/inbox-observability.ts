import { context, propagation, ROOT_CONTEXT, type Span } from '@opentelemetry/api';
import type { Observability } from '../../infrastructure/index.ts';

type Transition = 'accepted' | 'duplicate' | 'claimed' | 'completed' | 'retried';
type ObservedEvent = { id: string; source: 'user' | 'channel'; traceParent: string | null };

export function currentTraceParent(): string | null {
  const carrier: Record<string, string | undefined> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

export function createInboxObserver(
  observability: Observability | undefined,
): (transition: Transition, event: ObservedEvent) => void {
  if (!observability) return () => undefined;

  const { logger, meter, tracer } = observability;
  const transitions = meter.createCounter('inbox.event.transitions');

  return observe;

  function observe(transition: Transition, { id, source, traceParent }: ObservedEvent) {
    const attributes = { 'inbox.source': source, 'inbox.transition': transition };
    const parent = traceParent
      ? propagation.extract(ROOT_CONTEXT, { traceparent: traceParent })
      : context.active();

    tracer.startActiveSpan(`inbox.${transition}`, { attributes }, parent, recordTransition);

    function recordTransition(span: Span) {
      try {
        span.setAttribute('inbox.event.id', id);
        transitions.add(1, attributes);
        logger.debug({ event_id: id, source }, `inbox.${transition}`);
      } finally {
        span.end();
      }
    }
  }
}
