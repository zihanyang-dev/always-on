import { z } from 'zod';

type JsonValue = z.infer<z.ZodJSONSchema>;

/** Execution observations shared by platform-owned and device-owned harness adapters. */
export type ExecutionEvent =
  | { type: 'message_started'; index: number; role: 'user' | 'assistant' | 'tool' }
  | { type: 'text_delta'; index: number; text: string }
  | {
      type: 'message';
      index: number;
      role: 'user' | 'assistant' | 'tool';
      state: 'completed' | 'interrupted';
      text: string;
    }
  | { type: 'tool_started'; id: string; name: string; arguments: unknown }
  | { type: 'tool_finished'; id: string; name: string; isError: boolean }
  | { type: 'settled' };

/** Host-owned cancellation and acknowledged event delivery for one execution. */
export type ExecutionContext = {
  readonly signal?: AbortSignal;
  readonly emit: (event: ExecutionEvent) => Promise<void>;
};

/** Executor-owned continuation metadata; the platform stores it without interpreting its fields. */
export type ExecutionCheckpoint = Readonly<Record<string, JsonValue>>;

/** Restricts opaque continuation metadata to a transportable JSON object. */
export const EXECUTION_CHECKPOINT_SCHEMA: z.ZodType<ExecutionCheckpoint> = z.record(
  z.string(),
  z.json(),
);
