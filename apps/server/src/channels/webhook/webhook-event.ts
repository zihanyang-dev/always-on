import { Webhook, WebhookVerificationError } from 'standardwebhooks';
import { z } from 'zod';
import type { ChannelEvent, EventPayload } from '../../work/index.ts';

type WebhookEvent = Omit<ChannelEvent, 'workspaceId' | 'connectionId'>;
type ReadResult =
  | { ok: true; event: WebhookEvent }
  | {
      ok: false;
      error: 'invalid_signature' | 'invalid_input';
    };

const SOURCE_EVENT_ID = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[!-~]+$/);
const CONTEXT_ID = z.string().min(1).max(1000).refine(validText);
const EVENT = z.object({
  type: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_.-]*$/),
  data: z.custom<EventPayload>(
    (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  ),
  conversationId: CONTEXT_ID.optional(),
  replyTo: CONTEXT_ID.optional(),
  occurredAt: z.iso
    .datetime({ offset: true })
    .refine((time) => !time.startsWith('0000-'))
    .optional(),
});

export function readWebhookEvent({
  body,
  headers,
  signingSecret,
}: {
  body: Uint8Array;
  headers: Headers;
  signingSecret: string;
}): ReadResult {
  const id = SOURCE_EVENT_ID.safeParse(headers.get('webhook-id'));
  if (!id.success) return { ok: false, error: 'invalid_input' };

  if (!hasValidSignature({ body, headers, signingSecret, sourceEventId: id.data }))
    return { ok: false, error: 'invalid_signature' };

  const decoded = EVENT.safeParse(parseJsonBody(body));
  if (!decoded.success) return { ok: false, error: 'invalid_input' };

  const { type, data, ...context } = decoded.data;
  return {
    ok: true,
    event: { sourceEventId: id.data, eventType: type, payload: data, ...context },
  };
}

function hasValidSignature({
  body,
  headers,
  signingSecret,
  sourceEventId,
}: {
  body: Uint8Array;
  headers: Headers;
  signingSecret: string;
  sourceEventId: string;
}) {
  const verifier = new Webhook(signingSecret);
  try {
    verifier.verify(
      body,
      {
        'webhook-id': sourceEventId,
        'webhook-timestamp': headers.get('webhook-timestamp') ?? '',
        'webhook-signature': headers.get('webhook-signature') ?? '',
      },
      { jsonParse: false },
    );
  } catch (error) {
    if (error instanceof WebhookVerificationError) return false;
    throw error;
  }
  return true;
}

function validText(value: string) {
  return value.isWellFormed() && !value.includes('\u0000');
}

function parseJsonBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body), validateJsonValue);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError)
      return undefined;
    throw error;
  }
}

function validateJsonValue(key: string, value: unknown) {
  if (!validText(key) || (typeof value === 'string' && !validText(value)))
    throw new SyntaxError('Invalid Unicode in webhook JSON');
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new SyntaxError('Number is outside the supported JSON range');

  return value;
}
