import { z } from 'zod';

/** Public deployment settings that may safely reach an unauthenticated browser. */
export type PublicConfig = {
  name: string;
  capabilities: {
    agentExecution: boolean;
    localConnection: boolean;
    cloudSandbox: boolean;
  };
};

/** Validates the public settings contract without admitting deployment secrets. */
export const PUBLIC_CONFIG_SCHEMA: z.ZodType<PublicConfig> = z.object({
  name: z.string().min(1),
  capabilities: z.object({
    agentExecution: z.boolean(),
    localConnection: z.boolean(),
    cloudSandbox: z.boolean(),
  }),
});

/** Readiness of the API's required backing services. */
export type Readiness =
  | { status: 'ready'; checks: { database: 'up'; redis: 'up' } }
  | {
      status: 'unavailable';
      checks: { database: 'down'; redis: 'up' | 'down' } | { database: 'up'; redis: 'down' };
    };

/** Validates readiness responses, including the body of a 503 response. */
export const READINESS_SCHEMA: z.ZodType<Readiness> = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    checks: z.object({ database: z.literal('up'), redis: z.literal('up') }),
  }),
  z.object({
    status: z.literal('unavailable'),
    checks: z.union([
      z.object({ database: z.literal('down'), redis: z.enum(['up', 'down']) }),
      z.object({ database: z.literal('up'), redis: z.literal('down') }),
    ]),
  }),
]);
