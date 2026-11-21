import { setTimeout as delay } from 'node:timers/promises';
import type { Inbox, LeaseKey } from '../inbox/inbox-event.ts';

type InboxConsumer = {
  inbox: Pick<Inbox, 'claim' | 'retry'>;
  routeEvent: (lease: LeaseKey) => Promise<unknown>;
  reportError: (error: unknown) => void;
  signal: AbortSignal;
};

export async function consumeWorkInbox(options: InboxConsumer): Promise<void> {
  const { signal } = options;
  while (!signal.aborted) {
    if (await routeNextInput(options)) continue;

    try {
      await delay(250, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}

async function routeNextInput({ inbox, routeEvent, reportError }: InboxConsumer) {
  const [delivery] = await inbox.claim();
  if (!delivery) return false;

  const lease = { eventId: delivery.event.id, token: delivery.token };
  try {
    await routeEvent(lease);
  } catch (error) {
    reportError(error);
    await inbox.retry({ ...lease, delayMs: 1000 });
  }

  return true;
}
