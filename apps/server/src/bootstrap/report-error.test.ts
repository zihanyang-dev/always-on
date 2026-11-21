import { expect, it } from 'vitest';
import { ConfigurationError, describeError } from './report-error.js';

it('logs safe diagnostics without exposing database or SDK payloads through causes', () => {
  const dependency = Object.assign(new Error('Failed query: select $1; params: private-sample'), {
    code: '23503',
    detail: 'private-sample',
  });
  const resourceError = new Error('remote response contains private-sample');
  const failure = new SuppressedError(
    new Error('Write failed', { cause: dependency }),
    new AggregateError([resourceError], 'Cleanup failed'),
  );
  const diagnostic = describeError(failure);

  expect(diagnostic.causes?.[0]?.causes?.[0]).toMatchObject({ type: 'Error', code: '23503' });
  expect(diagnostic.causes?.[1]?.type).toBe('AggregateError');
  expect(JSON.stringify(diagnostic)).not.toContain('private-sample');
});

it('preserves the setting name for trusted configuration errors', () => {
  expect(describeError(new ConfigurationError('Configure MODEL_PROVIDERS'))).toMatchObject({
    type: 'ConfigurationError',
    message: 'Configure MODEL_PROVIDERS',
  });
});
