export type EmailConfig = { apiKey: string; from: string };
export type SendEmail = (message: { to: string; subject: string; text: string }) => Promise<void>;

/** Binds transactional email delivery to the deployment's Resend account. */
export function createEmailSender({ apiKey, from }: EmailConfig): SendEmail {
  return async function sendEmail({ to, subject, text }) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text }),
      signal: AbortSignal.timeout(10_000),
    });

    await response.body?.cancel();
    if (!response.ok) throw new Error(`Resend rejected email delivery (HTTP ${response.status})`);
  };
}
