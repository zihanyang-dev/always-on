import { z } from 'zod';
import { LOGIN_METHODS, type LoginMethod } from './users.js';

/** Public deployment settings that may safely reach an unauthenticated browser. */
export type PublicConfig = {
  name: string;
  authentication: { methods: LoginMethod[] };
  capabilities: {
    agentExecution: boolean;
    localConnection: boolean;
    cloudSandbox: boolean;
  };
};

/** Validates the public settings contract without admitting deployment secrets. */
export const PUBLIC_CONFIG_SCHEMA: z.ZodType<PublicConfig> = z.object({
  name: z.string().min(1),
  authentication: z.object({ methods: z.array(z.enum(LOGIN_METHODS)) }),
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

const READY_CHECKS_SCHEMA = z.object({
  database: z.literal('up'),
  redis: z.literal('up'),
});

const UNAVAILABLE_CHECKS_SCHEMA = z.union([
  z.object({ database: z.literal('down'), redis: z.enum(['up', 'down']) }),
  z.object({ database: z.literal('up'), redis: z.literal('down') }),
]);

/** Validates readiness responses, including the body of a 503 response. */
export const READINESS_SCHEMA: z.ZodType<Readiness> = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), checks: READY_CHECKS_SCHEMA }),
  z.object({ status: z.literal('unavailable'), checks: UNAVAILABLE_CHECKS_SCHEMA }),
]);
