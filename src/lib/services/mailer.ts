/**
 * Sending email. Production uses Resend. Tests and local development
 * (without a Resend key) write each email to .test-outbox/ as JSON instead,
 * so tests can read what was "sent".
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Resend } from 'resend';
import { env } from '../env.ts';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  /** Stops the provider sending the same email twice if we retry. */
  idempotencyKey: string;
}

export interface Mailer {
  send(email: OutgoingEmail): Promise<{ id: string }>;
}

export class MailerError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = 'MailerError';
    this.permanent = permanent;
  }
}

class ResendMailer implements Mailer {
  readonly #client: Resend;
  readonly #from: string;
  constructor(key: string, from: string) {
    this.#client = new Resend(key);
    this.#from = from;
  }
  async send(email: OutgoingEmail): Promise<{ id: string }> {
    const { data, error } = await this.#client.emails.send(
      {
        from: this.#from,
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(email.headers && { headers: email.headers }),
      },
      { idempotencyKey: email.idempotencyKey },
    );
    if (error || !data) {
      // Validation problems won't fix themselves; anything else may be temporary.
      const permanent = error?.name === 'validation_error' || error?.name === 'invalid_parameter';
      throw new MailerError(`Resend: ${error?.message ?? 'no response'}`, permanent);
    }
    return { id: data.id };
  }
}

export const TEST_OUTBOX_DIR = '.test-outbox';

class FileMailer implements Mailer {
  async send(email: OutgoingEmail): Promise<{ id: string }> {
    mkdirSync(TEST_OUTBOX_DIR, { recursive: true });
    const id = `local-${email.idempotencyKey}`;
    writeFileSync(
      join(TEST_OUTBOX_DIR, `${Date.now()}-${email.idempotencyKey}.json`),
      JSON.stringify({ id, ...email }, null, 2),
    );
    if (env().APP_ENV === 'development') console.info(`[mail] ${email.subject} → ${email.to}`);
    return { id };
  }
}

let instance: Mailer | undefined;

export function mailer(): Mailer {
  if (!instance) {
    const e = env();
    instance =
      e.APP_ENV !== 'test' && e.RESEND_API_KEY ? new ResendMailer(e.RESEND_API_KEY, e.EMAIL_FROM) : new FileMailer();
  }
  return instance;
}

/** Only for tests. */
export function setMailer(m: Mailer | undefined): void {
  instance = m;
}
