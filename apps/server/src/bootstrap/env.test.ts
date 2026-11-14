import { describe, expect, it } from 'vitest';
import { parseApiEnv, parseDatabaseEnv, parseWorkerEnv } from './env.js';

const CONNECTIONS = {
  DATABASE_URL: 'postgresql://user:private-password@localhost/app',
  REDIS_URL: 'redis://localhost:6379',
};

describe('deployment configuration', () => {
  it('validates each process without requiring unrelated configuration', () => {
    expect(parseWorkerEnv({ ...CONNECTIONS, PORT: 'not-a-port' }).WORKER_CONCURRENCY).toBe(4);
    expect(parseDatabaseEnv({ DATABASE_URL: CONNECTIONS.DATABASE_URL })).toEqual({
      DATABASE_URL: CONNECTIONS.DATABASE_URL,
    });
    expect(parseApiEnv(CONNECTIONS).PORT).toBe(3001);
    expect(parseApiEnv({ ...CONNECTIONS, REDIS_PREFIX: 'invalid:worker:prefix' }).PORT).toBe(3001);
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
});
