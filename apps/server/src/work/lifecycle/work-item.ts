import type { InboxEvent } from '../inbox/inbox-event.ts';

export type WorkLocation = { workspaceId: string; workId: string };
export type WorkspaceUser = { workspaceId: string; userId: string };
export type WorkThread = { connectionId: string; conversationId: string };

export type WorkItem = WorkLocation & {
  goal: string;
  progress: string | null;
  status: 'queued' | 'running' | 'waiting';
  createdAt: Date;
};

export type WorkRunLease = {
  token: string;
  expiresAt: Date;
  event: InboxEvent;
  work: Pick<WorkItem, 'workId' | 'goal' | 'progress'>;
};
