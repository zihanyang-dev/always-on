import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('bootstrap routes', () => {
  it('keeps liveness independent of backing-service outages', async () => {
    let probeCount = 0;
    const check = async () => {
      probeCount += 1;
      throw new Error('offline');
    };
    const app = createApp({
      name: 'Test',
      checks: { database: check, redis: check },
      onError: (error) => {
        throw error;
      },
    });
    const response = await app.request('/api/health/live');
    expect(response.status).toBe(200);
    expect(probeCount).toBe(0);
  });

  it('returns unavailable readiness without serializing dependency errors', async () => {
    const app = createApp({
      name: 'Test',
      checks: {
        database: async () => {
          throw new Error('secret-connection-string');
        },
        redis: async () => 'PONG',
      },
      onError: (error) => {
        throw error;
      },
    });
    const response = await app.request('/api/health/ready');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'unavailable',
      checks: { database: 'down', redis: 'up' },
    });
  });

  it('exposes only public configuration and marks unavailable features honestly', async () => {
    const app = createApp({
      name: 'A workspace',
      checks: { database: async () => {}, redis: async () => {} },
      onError: (error) => {
        throw error;
      },
    });
    const response = await app.request('/api/public-config');
    expect(await response.json()).toEqual({
      name: 'A workspace',
      capabilities: {
        agentExecution: false,
        localConnection: false,
        cloudSandbox: false,
      },
    });
  });
});
