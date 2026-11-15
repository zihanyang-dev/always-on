import { isAbsolute } from 'node:path';
import { z } from 'zod';

/** Pi's private continuation format; its transcript stays owned by the SDK. */
export type PiCheckpoint = {
  readonly kind: 'pi';
  readonly version: 1;
  readonly sessionFile: string;
};

const PI_CHECKPOINT_SCHEMA: z.ZodType<PiCheckpoint> = z.strictObject({
  kind: z.literal('pi'),
  version: z.literal(1),
  sessionFile: z.string().refine(isAbsolute, 'Pi checkpoints require an absolute session path'),
});

/** Restores only a recognized Pi continuation, failing explicitly on incompatible state. */
export function parsePiCheckpoint(input: unknown): PiCheckpoint | null {
  return PI_CHECKPOINT_SCHEMA.nullable().parse(input ?? null);
}

/** Captures an SDK file reference without exposing its format to the platform's Run journal. */
export function createPiCheckpoint(sessionFile: string): PiCheckpoint {
  return { kind: 'pi', version: 1, sessionFile };
}
