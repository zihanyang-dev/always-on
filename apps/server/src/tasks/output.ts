import type { ExecutionContext } from '@always-on/agent-runtime/execution';
import type { AgentMessage, SessionEvent } from '@always-on/contracts/agents';
import type { Database } from '../infrastructure/database/index.js';
import type { RunClaim } from './ownership.js';
import { writeRunMessage } from './store.js';

/** Projects native observations into durable message boundaries and replayable display updates. */
export function createRunOutput({
  db,
  claim,
  publish,
}: {
  db: Database;
  claim: RunClaim;
  publish: (event: SessionEvent) => Promise<void>;
}): ExecutionContext['emit'] {
  const messages = new Map<number, AgentMessage>();

  return emit;

  async function emit(event: Parameters<ExecutionContext['emit']>[0]) {
    switch (event.type) {
      case 'message_started':
        if (event.role === 'user') return;
        return saveMessage({ ...event, role: event.role, state: 'pending', text: '' });
      case 'message':
        if (event.role === 'user') return;
        return saveMessage({ ...event, role: event.role });
      case 'text_delta': {
        const message = messages.get(event.index);
        if (!message)
          throw new Error(`Run ${claim.run.id} received text before message ${event.index}`);

        const updated = { ...message, text: message.text + event.text };
        messages.set(event.index, updated);
        // Replay uses full drafts so a retained suffix can reconstruct the latest partial message.
        await publish({ type: 'message', message: updated });

        return;
      }
      case 'tool_started':
        return publish({
          type: 'tool',
          runId: claim.run.id,
          id: event.id,
          name: event.name,
          state: 'running',
        });
      case 'tool_finished':
        return publish({
          type: 'tool',
          runId: claim.run.id,
          id: event.id,
          name: event.name,
          state: event.isError ? 'failed' : 'completed',
        });
      case 'settled':
        // Only the execution owner can publish a terminal Run after resource cleanup and commit.
        return;
      default: {
        const exhaustive: never = event;
        throw new Error(`Unexpected execution event ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  async function saveMessage(message: {
    index: number;
    role: 'assistant' | 'tool';
    state: AgentMessage['state'];
    text: string;
  }) {
    const saved = await writeRunMessage({ db, claim, message });
    messages.set(message.index, saved);
    await publish({ type: 'message', message: saved });
  }
}
