import { authorizeMessageSubmission } from '../../access/index.ts';
import type { Database } from '../../infrastructure/database/index.ts';
import type { Observability } from '../../infrastructure/index.ts';
import type {
  ChannelEvent,
  Inbox,
  InboxEvent,
  InboxLease,
  InboxReceipt,
  LeaseKey,
  UserMessage,
  UserMessageReceipt,
} from './inbox-event.ts';
import { createInboxObserver, currentTraceParent } from './inbox-observability.ts';
import { appendInboxEvent } from './persistence/inbox-ingress.ts';
import { claimInboxEvents, settleInboxLease } from './persistence/inbox-leases.ts';

export function createInbox(db: Database, observability?: Observability): Inbox {
  const observe = createInboxObserver(observability);

  return { acceptUserMessage, acceptChannelEvent, claim, complete, retry };

  async function acceptUserMessage({
    workspaceId,
    userId,
    clientMessageId,
    text,
  }: UserMessage): Promise<UserMessageReceipt> {
    const source: InboxEvent['source'] = { kind: 'user', id: userId, eventId: clientMessageId };
    const traceParent = currentTraceParent();
    const event = { workspaceId, source, eventType: 'message.received', payload: { text } };

    const receipt = await transaction().execute<UserMessageReceipt>(async (tx) => {
      const access = await authorizeMessageSubmission(tx, { workspaceId, userId });
      if (access !== 'allowed') return { status: access };

      return appendInboxEvent(tx, event, traceParent);
    });

    observeReceipt(receipt, { source: 'user', traceParent });
    return receipt;
  }

  async function acceptChannelEvent({
    connectionId,
    sourceEventId,
    ...event
  }: ChannelEvent): Promise<InboxReceipt> {
    const source: InboxEvent['source'] = {
      kind: 'channel',
      id: connectionId,
      eventId: sourceEventId,
    };
    const traceParent = currentTraceParent();
    const receipt = await transaction().execute((tx) =>
      appendInboxEvent(tx, { ...event, source }, traceParent),
    );

    observeReceipt(receipt, { source: 'channel', traceParent });
    return receipt;
  }

  async function claim({
    limit = 1,
    leaseMs = 30_000,
  }: {
    limit?: number;
    leaseMs?: number;
  } = {}): Promise<InboxLease[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError('Inbox claim limit must be an integer from 1 to 100');
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1)
      throw new RangeError('Inbox lease must be a positive number of milliseconds');

    const leases = await transaction().execute((tx) => claimInboxEvents(tx, { limit, leaseMs }));
    for (const { event } of leases) {
      observe('claimed', {
        id: event.id,
        source: event.source.kind,
        traceParent: event.traceParent,
      });
    }
    return leases;
  }

  async function complete(lease: LeaseKey): Promise<boolean> {
    const event = await transaction().execute((tx) =>
      settleInboxLease(tx, lease, { kind: 'complete' }),
    );
    if (!event) return false;

    observe('completed', event);
    return true;
  }

  async function retry({
    eventId,
    token,
    delayMs,
  }: LeaseKey & { delayMs: number }): Promise<boolean> {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0)
      throw new RangeError('Inbox retry delay must be a non-negative number of milliseconds');

    const event = await transaction().execute((tx) =>
      settleInboxLease(tx, { eventId, token }, { kind: 'retry', delayMs }),
    );
    if (!event) return false;

    observe('retried', event);
    return true;
  }

  function observeReceipt(
    receipt: UserMessageReceipt,
    event: { source: InboxEvent['source']['kind']; traceParent: string | null },
  ) {
    if (receipt.status !== 'accepted') return;

    observe(receipt.duplicate ? 'duplicate' : 'accepted', { ...event, id: receipt.eventId });
  }

  function transaction() {
    return db.transaction().setIsolationLevel('read committed');
  }
}
