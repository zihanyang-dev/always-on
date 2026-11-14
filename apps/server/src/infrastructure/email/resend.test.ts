import assert from 'node:assert/strict';
import { expect, it } from 'vitest';
import { createResendSender } from './index.js';

it('sends authentication mail with a bounded request and parses the provider receipt', async () => {
  const requests: Request[] = [];
  const sendEmail = createResendSender({
    apiKey: 'test-api-key',
    from: 'Always On <onboarding@resend.dev>',
    request: async (input, options) => {
      requests.push(new Request(input, options));
      return Response.json({ id: '5728475b-8e9e-48b4-a4ba-ac0b4f85b14b' });
    },
  });
  await sendEmail({ to: 'recipient@example.com', subject: 'Verify', text: 'Verification link' });
  const [request] = requests;
  assert.ok(request);
  expect(request.url).toBe('https://api.resend.com/emails');
  expect(request.headers.get('authorization')).toBe('Bearer test-api-key');
  expect(await request.json()).toEqual({
    from: 'Always On <onboarding@resend.dev>',
    to: 'recipient@example.com',
    subject: 'Verify',
    text: 'Verification link',
  });
});

it('keeps provider error bodies and credential URLs out of delivery errors', async () => {
  const sendEmail = createResendSender({
    apiKey: 'test-api-key',
    from: 'onboarding@resend.dev',
    request: async () => Response.json({ message: 'private-reset-token' }, { status: 503 }),
  });
  await expect(
    sendEmail({ to: 'recipient@example.com', subject: 'Reset', text: 'private-reset-token' }),
  ).rejects.toThrow('Resend delivery failed with HTTP 503');
});
