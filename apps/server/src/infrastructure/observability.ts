import { context, type Meter, metrics, propagation, type Tracer, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { type LevelWithSilent, type Logger, pino } from 'pino';

export type ObservabilityConfig = {
  serviceName: string;
  logLevel: LevelWithSilent;
  otlpEndpoint: string | undefined;
};

export type Observability = {
  logger: Logger;
  tracer: Tracer;
  meter: Meter;
};

/** Owns process-wide telemetry providers and flushes them on shutdown. */
export function startObservability({
  serviceName,
  logLevel,
  otlpEndpoint,
}: ObservabilityConfig): Observability & AsyncDisposable {
  const logger = pino({
    base: { service_name: serviceName },
    level: logLevel,
    mixin: activeTraceFields,
  });
  const resource = resourceFromAttributes({ 'service.name': serviceName });
  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: otlpEndpoint
      ? [
          new BatchSpanProcessor({
            exporter: new OTLPTraceExporter({ url: signalUrl(otlpEndpoint, 'traces') }),
          }),
        ]
      : [],
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: otlpEndpoint
      ? [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ url: signalUrl(otlpEndpoint, 'metrics') }),
          }),
        ]
      : [],
  });

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(tracerProvider);
  metrics.setGlobalMeterProvider(meterProvider);

  return {
    logger,
    tracer: tracerProvider.getTracer('always-on'),
    meter: meterProvider.getMeter('always-on'),
    [Symbol.asyncDispose]: close,
  };

  async function close() {
    const results = await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
    if (results.some((result) => result.status === 'rejected')) {
      logger.error('telemetry.flush_failed');
    }
    metrics.disable();
    trace.disable();
    propagation.disable();
    context.disable();
  }
}

function activeTraceFields() {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext ? { trace_id: spanContext.traceId, span_id: spanContext.spanId } : {};
}

function signalUrl(endpoint: string, signal: 'traces' | 'metrics') {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/${signal}`;
  return url.href;
}
