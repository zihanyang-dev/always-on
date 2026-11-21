type JsonValue = null | boolean | number | string | JsonValue[] | EventPayload;
export type EventPayload = { [key: string]: JsonValue | undefined };

export type ChannelEvent = {
  workspaceId: string;
  connectionId: string;
  sourceEventId: string;
  eventType: string;
  payload: EventPayload;
  conversationId?: string | undefined;
  replyTo?: string | undefined;
  occurredAt?: string | undefined;
};

export type UserMessage = {
  workspaceId: string;
  userId: string;
  clientMessageId: string;
  text: string;
};

export type InboxReceipt =
  | { status: 'accepted'; eventId: string; duplicate: boolean }
  | { status: 'event_id_conflict' };

export type UserMessageReceipt = InboxReceipt | { status: 'not_found' | 'forbidden' };

export type InboxEvent = {
  id: string;
  workspaceId: string;
  source: { kind: 'user' | 'channel'; id: string; eventId: string };
  eventType: string;
  payload: EventPayload;
  conversationId: string | null;
  replyTo: string | null;
  occurredAt: Date | null;
  receivedAt: Date;
  traceParent: string | null;
};

export type InboxLease = {
  event: InboxEvent;
  token: string;
  expiresAt: Date;
  attempt: number;
};

export type LeaseKey = { eventId: string; token: string };

export type Inbox = {
  acceptUserMessage: (message: UserMessage) => Promise<UserMessageReceipt>;
  acceptChannelEvent: (event: ChannelEvent) => Promise<InboxReceipt>;
  claim: (options?: { limit?: number; leaseMs?: number }) => Promise<InboxLease[]>;
  complete: (lease: LeaseKey) => Promise<boolean>;
  retry: (input: LeaseKey & { delayMs: number }) => Promise<boolean>;
};
