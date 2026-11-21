import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readApiConfig } from './config.ts';

const ENV = {
  DATABASE_URL: 'postgresql://localhost/always_on',
  BETTER_AUTH_SECRET: 'a-secret-for-testing-longer-than-32-characters',
};

test('reads the listening address separately from the public OAuth origin', () => {
  const config = readApiConfig({
    ...ENV,
    NODE_ENV: 'production',
    PORT: '8080',
    BETTER_AUTH_URL: 'https://example.test/',
    GITHUB_CLIENT_ID: 'identifier',
    GITHUB_CLIENT_SECRET: 'secret',
  });

  assert.equal(config.port, 8080);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.auth.origin, 'https://example.test');
  assert.deepEqual(config.auth.github, { clientId: 'identifier', clientSecret: 'secret' });
});

test('rejects incomplete OAuth settings and a non-HTTPS production origin', () => {
  assert.throws(
    () => readApiConfig({ ...ENV, GOOGLE_CLIENT_ID: 'identifier' }),
    /GOOGLE_CLIENT_SECRET/,
  );
  assert.throws(() => readApiConfig({ ...ENV, NODE_ENV: 'production' }), /must use HTTPS/);
});

test('reports the invalid field without including its configured value', () => {
  assert.throws(() => readApiConfig({ ...ENV, DATABASE_URL: 'example-secret' }), {
    message: 'Invalid API configuration: DATABASE_URL',
  });
});
