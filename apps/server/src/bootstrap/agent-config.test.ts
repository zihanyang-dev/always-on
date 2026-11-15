import { expect, it } from 'vitest';
import { parseCloudAgentConfiguration } from './agent-config.js';

const REQUIRED_SETTINGS = {
  AGENT_SESSION_DIRECTORY: '/tmp/always-on-agent-config-test',
  DEEPSEEK_API_KEY: 'test-model-key',
  E2B_API_KEY: 'test-sandbox-key',
};

it('leaves cloud execution disabled when no model connection is configured', () => {
  expect(parseCloudAgentConfiguration({})).toBeNull();
});

it('resolves multiple provider references without putting credentials inside provider definitions', () => {
  const config = parseCloudAgentConfiguration({
    ...REQUIRED_SETTINGS,
    GROQ_API_KEY: 'test-second-provider-key',
    MODEL_PROVIDERS: JSON.stringify([
      { provider: 'deepseek', credentialEnvironmentKey: 'DEEPSEEK_API_KEY' },
      { provider: 'groq', credentialEnvironmentKey: 'GROQ_API_KEY' },
    ]),
  });
  expect(config?.connections.map((connection) => connection.provider)).toEqual([
    'deepseek',
    'groq',
  ]);
  expect(config?.connections.at(1)?.apiKey).toBe('test-second-provider-key');
});

it('rejects duplicate providers and incomplete self-hosted sandbox endpoints', () => {
  const provider = { provider: 'deepseek', credentialEnvironmentKey: 'DEEPSEEK_API_KEY' };
  expect(() =>
    parseCloudAgentConfiguration({
      ...REQUIRED_SETTINGS,
      MODEL_PROVIDERS: JSON.stringify([provider, provider]),
    }),
  ).toThrow('repeats a provider');
  expect(() =>
    parseCloudAgentConfiguration({ ...REQUIRED_SETTINGS, E2B_API_URL: 'http://localhost:43000' }),
  ).toThrow('E2B_API_URL and E2B_SANDBOX_URL together');
});

it('reports invalid cloud settings without including submitted secrets', () => {
  try {
    parseCloudAgentConfiguration({
      ...REQUIRED_SETTINGS,
      E2B_API_KEY: '',
      AGENT_SESSION_DIRECTORY: 'relative/private-key',
    });
    expect.fail('Expected invalid cloud settings to fail');
  } catch (error) {
    expect(String(error)).toContain('directory');
    expect(String(error)).not.toContain('test-model-key');
    expect(String(error)).not.toContain('relative/private-key');
  }
});
