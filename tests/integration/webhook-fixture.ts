import { createHmac } from 'node:crypto';

export function signWebhook({
  sourceEventId,
  body,
  key,
}: {
  sourceEventId: string;
  body: string;
  key: Buffer;
}): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', key)
    .update(`${sourceEventId}.${timestamp}.${body}`)
    .digest('base64');

  return {
    'webhook-id': sourceEventId,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${signature}`,
  };
}
