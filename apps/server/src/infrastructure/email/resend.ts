import { z } from 'zod';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DELIVERY_TIMEOUT_MS = 5_000;
const DELIVERY_RECEIPT_SCHEMA = z.object({ id: z.uuid() });
const EMAIL_ADDRESS_SCHEMA = z.email();

/** Accepts a plain mailbox or a display name followed by one mailbox. */
export const EMAIL_FROM_SCHEMA = z
  .string()
  .refine(isSenderAddress, 'Use an email address or Name <email@example.com>');

/** A transactional message; verification and reset tokens stay inside its body. */
export type EmailMessage = { to: string; subject: string; text: string };
/** Delivery capability injected into authentication and replaced by a mailbox in tests. */
export type SendEmail = (message: EmailMessage, signal?: AbortSignal) => Promise<void>;

/** Creates a bounded Resend transport without retaining request or response bodies in errors. */
export function createResendSender({
  apiKey,
  from,
  request = fetch,
}: {
  apiKey: string;
  from: string;
  request?: typeof fetch;
}): SendEmail {
  return send;

  async function send(message: EmailMessage, signal?: AbortSignal) {
    // A stalled provider must not keep accepted authentication work alive indefinitely.
    const deadline = AbortSignal.timeout(DELIVERY_TIMEOUT_MS);
    const response = await request(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, ...message }),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    // Provider bodies may contain credentials or reset URLs; errors carry only the HTTP status.
    if (!response.ok) throw new Error(`Resend delivery failed with HTTP ${response.status}`);
    DELIVERY_RECEIPT_SCHEMA.parse(await response.json());
  }
}

function isSenderAddress(value: string) {
  // Reject line breaks before parsing either supported sender format.
  if (/[\r\n]/.test(value)) return false;
  const address = value.match(/^[^<>]+<([^<>]+)>$/)?.[1] ?? value;
  return EMAIL_ADDRESS_SCHEMA.safeParse(address).success;
}
