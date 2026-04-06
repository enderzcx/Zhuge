/**
 * OpenTelemetry tracing — 3-layer span model (Google ADK-Go inspired).
 *
 * Span hierarchy:
 *   pipeline_cycle (root)
 *     ├─ data_collect
 *     ├─ agent:{name} (LLM call)
 *     │   └─ tool:{name}
 *     ├─ trade:execute
 *     └─ agent:researcher
 *
 * Exports to Jaeger via OTLP HTTP.
 */

import { trace, SpanStatusCode, context } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import resourcePkg from '@opentelemetry/resources';
const { resourceFromAttributes } = resourcePkg;

let sdk = null;
let tracer = null;

export function initTracing(serviceName = 'tradeagent', otlpEndpoint) {
  if (!otlpEndpoint) {
    // No endpoint configured — return noop tracer
    tracer = trace.getTracer(serviceName);
    return tracer;
  }

  const exporter = new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` });

  sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    traceExporter: exporter,
  });

  sdk.start();
  tracer = trace.getTracer(serviceName);
  return tracer;
}

/**
 * Start a root span (e.g., pipeline_cycle).
 * Returns { span, ctx } — pass ctx to child spans.
 */
export function startRootSpan(name, attributes = {}) {
  if (!tracer) tracer = trace.getTracer('tradeagent');
  const span = tracer.startSpan(name, { attributes });
  const ctx = trace.setSpan(context.active(), span);
  return { span, ctx };
}

/**
 * Start a child span under a parent context.
 * Returns { span, ctx }.
 */
export function startChildSpan(parentCtx, name, attributes = {}) {
  if (!tracer) tracer = trace.getTracer('tradeagent');
  const span = tracer.startSpan(name, { attributes }, parentCtx);
  const ctx = trace.setSpan(parentCtx, span);
  return { span, ctx };
}

/**
 * End a span, optionally marking it as error.
 */
export function endSpan(span, error = null) {
  if (!span) return;
  if (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message || String(error) });
    span.recordException(error);
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();
}

/**
 * Helper: wrap an async function in a child span.
 */
export async function withSpan(parentCtx, name, attributes, fn) {
  const { span, ctx } = startChildSpan(parentCtx, name, attributes);
  try {
    const result = await fn(ctx);
    endSpan(span);
    return result;
  } catch (err) {
    endSpan(span, err);
    throw err;
  }
}

export async function shutdownTracing() {
  if (sdk) await sdk.shutdown();
}
