// EMAIL SENDER ADAPTERS: RESEND, POSTMARK, SMTP, AND A LOG SENDER FOR DEVELOPMENT AND TESTS (4.4)
// A failed send always throws MailError with a plain reason, so the page can show it and offer a resend.

// -- DEP-MODULES -- //
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// -- TYPES -- //

export type Mail = { to: string; subject: string; text: string; html: string; tag?: string };
export interface Mailer {
	readonly kind: 'log' | 'resend' | 'postmark' | 'smtp';
	send(mail: Mail): Promise<void>;
}
export type MailerConfig = {
	provider: 'log' | 'resend' | 'postmark' | 'smtp';
	from: string;
	resendApiKey?: string;
	postmarkToken?: string;
	smtpUrl?: string;
	/** Log sender only: append each mail as a JSON line here, so a check can read what was sent. */
	outboxFile?: string;
	/** Log sender only: a mail to an address matching this pattern fails, to test the visible error and resend. */
	failPattern?: string;
};

export class MailError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'MailError';
	}
}

// -- STATES -- //

/** Mails the log sender has taken, newest last. Read by tests and the development outbox page. */
export const outbox: (Mail & { at: string })[] = [];

// -- FUNCTIONS -- //

function logMailer(config: MailerConfig): Mailer {
	const fail = config.failPattern ? new RegExp(config.failPattern, 'i') : null;
	return {
		kind: 'log',
		async send(mail) {
			if (fail?.test(mail.to))
				throw new MailError('The mail server refused this address (test failure).');
			const entry = { ...mail, at: new Date().toISOString() };
			outbox.push(entry);
			if (config.outboxFile) {
				mkdirSync(dirname(config.outboxFile), { recursive: true });
				appendFileSync(config.outboxFile, JSON.stringify(entry) + '\n');
			}
		}
	};
}

function resendMailer(config: MailerConfig): Mailer {
	if (!config.resendApiKey)
		throw new Error('EMAIL_PROVIDER is resend but RESEND_API_KEY is not set');
	return {
		kind: 'resend',
		async send(mail) {
			const res = await fetch('https://api.resend.com/emails', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${config.resendApiKey}`,
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					from: config.from,
					to: [mail.to],
					subject: mail.subject,
					html: mail.html,
					text: mail.text
				})
			}).catch((e) => {
				throw new MailError('The email service could not be reached.', { cause: e });
			});
			if (!res.ok) throw new MailError(`The email service refused the message (${res.status}).`);
		}
	};
}

function postmarkMailer(config: MailerConfig): Mailer {
	if (!config.postmarkToken)
		throw new Error('EMAIL_PROVIDER is postmark but POSTMARK_TOKEN is not set');
	return {
		kind: 'postmark',
		async send(mail) {
			const res = await fetch('https://api.postmarkapp.com/email', {
				method: 'POST',
				headers: {
					'x-postmark-server-token': config.postmarkToken!,
					'content-type': 'application/json',
					accept: 'application/json'
				},
				body: JSON.stringify({
					From: config.from,
					To: mail.to,
					Subject: mail.subject,
					HtmlBody: mail.html,
					TextBody: mail.text,
					MessageStream: 'outbound',
					Tag: mail.tag
				})
			}).catch((e) => {
				throw new MailError('The email service could not be reached.', { cause: e });
			});
			if (!res.ok) throw new MailError(`The email service refused the message (${res.status}).`);
		}
	};
}

function smtpMailer(config: MailerConfig): Mailer {
	if (!config.smtpUrl) throw new Error('EMAIL_PROVIDER is smtp but SMTP_URL is not set');
	return {
		kind: 'smtp',
		async send(mail) {
			// Loaded on first use, so a server that sends no mail never pulls it in
			const { createTransport } = await import('nodemailer');
			try {
				await createTransport(config.smtpUrl!).sendMail({
					from: config.from,
					to: mail.to,
					subject: mail.subject,
					text: mail.text,
					html: mail.html
				});
			} catch (e) {
				throw new MailError('The mail server refused the message.', { cause: e });
			}
		}
	};
}

/** Builds the sender for a configuration. A provider with a missing key fails at start, never at the first send. */
export function createMailer(config: MailerConfig): Mailer {
	switch (config.provider) {
		case 'resend':
			return resendMailer(config);
		case 'postmark':
			return postmarkMailer(config);
		case 'smtp':
			return smtpMailer(config);
		default:
			return logMailer(config);
	}
}
