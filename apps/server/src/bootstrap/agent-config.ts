import { isAbsolute } from 'node:path';
import type { ModelConnection } from '@always-on/agent-runtime/pi';
import { z } from 'zod';

const ENVIRONMENT_SOURCE_SCHEMA = z
  .looseObject({})
  .pipe(z.record(z.string(), z.string().optional()));

const PROVIDER_SCHEMA = z.object({
  provider: z.string().trim().min(1).max(200),
  credentialEnvironmentKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  baseUrl: z.url({ protocol: /^https?$/ }).optional(),
});
const SANDBOX_CONNECTION_SCHEMA = z
  .object({
    apiKey: z.string().min(1),
    apiUrl: z.url({ protocol: /^https?$/ }).optional(),
    sandboxUrl: z.url({ protocol: /^https?$/ }).optional(),
  })
  .transform(({ apiKey, apiUrl, sandboxUrl }) => ({
    apiKey,
    ...(apiUrl ? { apiUrl } : {}),
    ...(sandboxUrl ? { sandboxUrl } : {}),
  }));
const CLOUD_AGENT_SCHEMA = z.object({
  directory: z.string().refine(isAbsolute, 'Use an absolute Agent state directory'),
  defaultModel: z.object({ provider: z.string().min(1), id: z.string().min(1) }),
  sandbox: SANDBOX_CONNECTION_SCHEMA,
});

/** Deployment-owned credentials and storage, separate from user-selected Agent settings. */
export interface CloudAgentConfiguration extends z.infer<typeof CLOUD_AGENT_SCHEMA> {
  readonly connections: readonly ModelConnection[];
}

/** Resolves provider credential references once at the process configuration boundary. */
export function parseCloudAgentConfiguration(input: unknown): CloudAgentConfiguration | null {
  // Node's process.env is an exotic object; normalize its own fields before record parsing.
  const environment = ENVIRONMENT_SOURCE_SCHEMA.parse(input);
  if (!environment.MODEL_PROVIDERS && !environment.DEEPSEEK_API_KEY) return null;

  const providers = readProviders(environment.MODEL_PROVIDERS);
  const connections = providers.map((provider) => {
    const apiKey = environment[provider.credentialEnvironmentKey];
    if (!apiKey) throw new Error(`Configure model credential ${provider.credentialEnvironmentKey}`);

    return {
      provider: provider.provider,
      apiKey,
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    };
  });
  const hasApiUrl = Boolean(environment.E2B_API_URL);
  const hasSandboxUrl = Boolean(environment.E2B_SANDBOX_URL);
  if (hasApiUrl !== hasSandboxUrl)
    throw new Error('Configure E2B_API_URL and E2B_SANDBOX_URL together for self-hosted E2B');

  const result = CLOUD_AGENT_SCHEMA.safeParse({
    directory: environment.AGENT_SESSION_DIRECTORY,
    defaultModel: {
      provider: environment.DEFAULT_MODEL_PROVIDER ?? 'deepseek',
      id: environment.DEFAULT_MODEL_ID ?? 'deepseek-flash',
    },
    sandbox: {
      apiKey: environment.E2B_API_KEY,
      ...(environment.E2B_API_URL ? { apiUrl: environment.E2B_API_URL } : {}),
      ...(environment.E2B_SANDBOX_URL ? { sandboxUrl: environment.E2B_SANDBOX_URL } : {}),
    },
  });
  if (result.success) return { ...result.data, connections };

  // Values may be credentials; report only configuration field names.
  const fields = result.error.issues.map((issue) => issue.path.join('.'));
  throw new Error(`Invalid cloud Agent configuration: ${fields.join(', ')}`);
}

function readProviders(serialized: string | undefined) {
  if (!serialized) return [{ provider: 'deepseek', credentialEnvironmentKey: 'DEEPSEEK_API_KEY' }];

  let input: unknown;
  try {
    input = JSON.parse(serialized);
  } catch {
    // JSON syntax errors quote raw input, which may accidentally contain credentials.
    throw new Error('MODEL_PROVIDERS must contain a JSON array');
  }
  const result = z.array(PROVIDER_SCHEMA).min(1).max(20).safeParse(input);
  if (!result.success) throw new Error('MODEL_PROVIDERS contains an invalid provider definition');

  const identities = new Set(result.data.map((provider) => provider.provider));
  if (identities.size !== result.data.length) throw new Error('MODEL_PROVIDERS repeats a provider');

  return result.data;
}
