import { expect, it } from 'vitest';
import { CREATE_AGENT_SCHEMA } from './agents.js';
import { MODEL_REFERENCE_SCHEMA } from './models.js';

it('accepts provider-defined model identities without a product-owned vendor catalogue', () => {
  expect(
    MODEL_REFERENCE_SCHEMA.parse({ provider: 'custom-provider', id: 'custom-model@2026' }),
  ).toEqual({ provider: 'custom-provider', id: 'custom-model@2026' });
});

it('keeps model choice explicit instead of introducing a deployment default into the contract', () => {
  const configuration = {
    workspaceId: 'workspace-1',
    name: 'Research',
    instructions: 'Investigate the request.',
    reasoningEffort: 'high',
  };
  expect(CREATE_AGENT_SCHEMA.safeParse(configuration).success).toBe(false);
  expect(
    CREATE_AGENT_SCHEMA.parse({
      ...configuration,
      model: { provider: 'another-provider', id: 'another-model' },
    }).model,
  ).toEqual({ provider: 'another-provider', id: 'another-model' });
});

it('rejects credentials submitted as Agent configuration', () => {
  const configuration = {
    workspaceId: 'workspace-1',
    name: 'Research',
    instructions: 'Investigate the request.',
    reasoningEffort: 'high',
    model: { provider: 'custom-provider', id: 'custom-model' },
    apiKey: 'not-a-product-field',
  };
  expect(CREATE_AGENT_SCHEMA.safeParse(configuration).success).toBe(false);
});
