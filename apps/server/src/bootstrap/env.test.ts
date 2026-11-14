import { describe, expect, it } from 'vitest';
import { parseApiEnv, parseDatabaseEnv, parseWorkerEnv } from './env.js';

const CONNECTIONS = {
  DATABASE_URL: 'postgresql://user:private-password@localhost/app',
  REDIS_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'test-authentication-secret-at-least-thirty-two-characters',
};

describe('deployment configuration', () => {
  it('validates each process without requiring unrelated configuration', () => {
    expect(parseWorkerEnv({ ...CONNECTIONS, PORT: 'not-a-port' }).WORKER_CONCURRENCY).toBe(4);
    expect(parseDatabaseEnv({ DATABASE_URL: CONNECTIONS.DATABASE_URL })).toEqual({
      DATABASE_URL: CONNECTIONS.DATABASE_URL,
    });
    expect(parseApiEnv(CONNECTIONS).PORT).toBe(3001);
    expect(parseWorkerEnv({ ...CONNECTIONS, BETTER_AUTH_SECRET: '' }).REDIS_PREFIX).toBe(
      'always-on',
    );
  });

  it('rejects invalid limits and reports field names without input values', () => {
    expect(() => parseWorkerEnv({ ...CONNECTIONS, WORKER_CONCURRENCY: '0' })).toThrow(
      'WORKER_CONCURRENCY',
    );
    try {
      parseApiEnv({
        ...CONNECTIONS,
        PORT: 'private-invalid-value',
        REDIS_URL: 'secret-redis-value',
      });
      expect.fail('Expected configuration parsing to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('PORT');
      expect(String(error)).not.toContain('private-invalid-value');
      expect(String(error)).not.toContain('secret-redis-value');
      expect(String(error)).not.toContain('private-password');
    }
  });

  it('requires complete OAuth credentials without requiring disabled providers', () => {
    expect(parseApiEnv(CONNECTIONS).GOOGLE_CLIENT_ID).toBeUndefined();
    expect(() => parseApiEnv({ ...CONNECTIONS, GOOGLE_CLIENT_ID: 'client-id' })).toThrow(
      'GOOGLE_CLIENT_SECRET',
    );
    expect(() => parseApiEnv({ ...CONNECTIONS, GITHUB_CLIENT_SECRET: 'secret' })).toThrow(
      'GITHUB_CLIENT_ID',
    );
    expect(() => parseApiEnv({ ...CONNECTIONS, NODE_ENV: 'production' })).toThrow(
      'BETTER_AUTH_URL',
    );
    expect(() => parseApiEnv({ ...CONNECTIONS, EMAIL_FROM: 'invalid-sender' })).toThrow(
      'EMAIL_FROM',
    );
  });
});
