import { z } from 'zod';

export const MESSAGE_CONTENT = z.object({
  text: z.string().min(1).max(8000).refine(validMessage),
  target: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('new_work') }),
      z.object({ kind: z.literal('existing_work'), workId: z.uuid() }),
    ])
    .optional(),
});

export type MessageContent = z.output<typeof MESSAGE_CONTENT>;

function validMessage(text: string) {
  return text.trim().length > 0 && text.isWellFormed() && !text.includes('\u0000');
}
