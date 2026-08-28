/**
 * Mailer — outbound email over SMTP (Phase 22).
 *
 * Purpose: the one place the application talks SMTP. Domain code that
 * sends mail takes a `Mailer` and never imports nodemailer, so what it
 * needs from the outside world is stated as an interface it owns, and
 * the adapter here satisfies it (rule 8: infrastructure adapts to
 * domain interfaces).
 *
 * Configuration comes from the environment, as the database file does:
 * SMTP_HOST (required to send at all), SMTP_PORT (default 25),
 * SMTP_FROM (the sender address; default mingle@localhost), SMTP_SECURE
 * ("true" for implicit TLS), and SMTP_USER / SMTP_PASSWORD when the
 * relay authenticates. The compose stack points these at a Mailpit
 * container so development and the real-path test deliver to a real
 * SMTP server rather than a stub.
 *
 * Public interface: `Mailer`, `MailMessage`, `SmtpConfig`,
 * `smtpConfigFromEnv`, `smtpMailer`.
 *
 * Owner context: infrastructure (mail adapter).
 */
import { createTransport } from "nodemailer";

/** One outbound message. Plain text only — nothing here renders HTML. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** What domain code needs from the outside world to send mail. */
export interface Mailer {
  /** Delivers one message; rejects with the transport's error on failure. */
  send(message: MailMessage): Promise<void>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  /** The From: address on every message. */
  from: string;
  /** True for implicit TLS (typically port 465); false for plain/STARTTLS. */
  secure: boolean;
  user?: string;
  password?: string;
}

/**
 * Reads the SMTP settings from the environment.
 *
 * @param env - the environment to read; defaults to process.env
 * @returns the config, or null when SMTP_HOST is unset — the deployment
 *   has not been given a mail server, and callers decide what that means
 */
export function smtpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;
  const port = Number(env.SMTP_PORT ?? 25);
  return {
    host,
    port: Number.isSafeInteger(port) && port > 0 ? port : 25,
    from: env.SMTP_FROM?.trim() || "mingle@localhost",
    secure: env.SMTP_SECURE === "true",
    user: env.SMTP_USER || undefined,
    password: env.SMTP_PASSWORD || undefined,
  };
}

/**
 * A Mailer that delivers over SMTP with nodemailer.
 *
 * @param config - the relay to speak to and the sender address
 */
export function smtpMailer(config: SmtpConfig): Mailer {
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.password ?? "" } : undefined,
  });
  return {
    async send(message) {
      await transport.sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
  };
}
