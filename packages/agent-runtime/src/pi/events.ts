import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ExecutionEvent } from '../execution.js';

type MessageEvent = Extract<AgentSessionEvent, { type: 'message_start' | 'message_end' }>;
type MessageUpdate = Extract<AgentSessionEvent, { type: 'message_update' }>;

/** Assigns message ordinals within one execution and interprets only the observed SDK events. */
export function createSessionObserver(
  onEvent: (event: ExecutionEvent) => void,
): (event: AgentSessionEvent) => void {
  let messageIndex = -1;

  return observeEvent;

  function observeEvent(event: AgentSessionEvent) {
    if (event.type === 'message_start') messageIndex += 1;

    const projected = mapSessionEvent(event, messageIndex);
    if (projected) onEvent(projected);
  }
}

function mapSessionEvent(event: AgentSessionEvent, index: number): ExecutionEvent | undefined {
  switch (event.type) {
    case 'message_start':
    case 'message_end':
      return mapMessage(event, index);
    case 'message_update':
      return mapTextDelta(event, index);
    case 'tool_execution_start':
      return {
        type: 'tool_started',
        id: event.toolCallId,
        name: event.toolName,
      };
    case 'tool_execution_end':
      return {
        type: 'tool_finished',
        id: event.toolCallId,
        name: event.toolName,
        isError: event.isError,
      };
    case 'agent_settled':
      return { type: 'settled' };
    case 'agent_start':
    case 'agent_end':
    case 'turn_start':
    case 'turn_end':
    case 'tool_execution_update':
    case 'queue_update':
    case 'compaction_start':
    case 'compaction_end':
    case 'entry_appended':
    case 'session_info_changed':
    case 'thinking_level_changed':
    case 'auto_retry_start':
    case 'auto_retry_end':
    case 'summarization_retry_scheduled':
    case 'summarization_retry_attempt_start':
    case 'summarization_retry_finished':
    case 'bash_execution_update':
      // Native control and transcript events remain SDK-owned; they are not product messages.
      return;
    default: {
      const exhaustive: never = event;
      throw new Error(`Unexpected Pi session event: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function mapMessage(event: MessageEvent, index: number): ExecutionEvent | undefined {
  const { message } = event;
  if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'toolResult')
    return;

  const role = message.role === 'toolResult' ? 'tool' : message.role;
  if (event.type === 'message_start') return { type: 'message_started', index, role };

  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
  const isInterrupted =
    message.role === 'assistant' &&
    message.stopReason !== 'stop' &&
    message.stopReason !== 'toolUse';

  return { type: 'message', index, role, state: isInterrupted ? 'interrupted' : 'completed', text };
}

function mapTextDelta(event: MessageUpdate, index: number): ExecutionEvent | undefined {
  if (event.assistantMessageEvent.type !== 'text_delta') return;

  return { type: 'text_delta', index, text: event.assistantMessageEvent.delta };
}
