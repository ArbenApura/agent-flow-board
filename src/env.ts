// ENVIRONMENT VARIABLES, VALIDATED WHEN THE APP STARTS. A MISSING OR BAD VALUE FAILS LOUDLY, NEVER SILENTLY.
// -- DEP-MODULES -- //
import { defineEnvVars } from '@sveltejs/kit/env';

// -- FUNCTIONS -- //

const optional = (value: string | undefined) => (value && value.trim() !== '' ? value : undefined);

// -- CONSTANTS -- //

export const variables = defineEnvVars({
	AFB_STORAGE_DIR: {
		description: 'Folder for attachments when S3 is not configured.',
		schema: optional
	},
	S3_ENDPOINT: {
		description: 'S3 compatible endpoint (MinIO, AWS S3 or any other S3 compatible store).',
		schema: optional
	},
	S3_BUCKET: { description: 'S3 bucket for attachments.', schema: optional },
	S3_ACCESS_KEY_ID: { description: 'S3 access key id.', schema: optional },
	S3_SECRET_ACCESS_KEY: { description: 'S3 secret access key.', schema: optional },
	AFB_SEED_DEMO: {
		description:
			'Set to 1 to fill an empty database with the demo orgs, items and sign ins (local and previews only).',
		schema: (value) => value === '1'
	},
	AFB_ENABLE_GALLERY: {
		description: 'Set to 1 to serve /dev/gallery. Never set in a deployment.',
		schema: (value) => value === '1'
	},
	AFB_BASE_URL: {
		description:
			'The public address of this app, for example https://board.example.com. Used in emails and sign in.',
		schema: (value) => {
			if (!value)
				throw new Error('AFB_BASE_URL is required, for example https://board.example.com');
			try {
				new URL(value);
			} catch {
				throw new Error('AFB_BASE_URL must be a full address such as https://board.example.com');
			}
			return value.replace(/\/$/, '');
		}
	},
	BETTER_AUTH_SECRET: {
		description:
			'A random secret of at least 32 characters that signs sessions. Keep it private and stable.',
		schema: (value) => {
			if (!value || value.length < 32)
				throw new Error('BETTER_AUTH_SECRET is required and must be at least 32 characters');
			return value;
		}
	},
	DATABASE_URL: {
		description:
			'PostgreSQL connection for the app as the app_runtime role. The server refuses to start without it.',
		schema: optional
	},
	DATABASE_OWNER_URL: {
		description:
			'PostgreSQL connection as the migration owner, used only by the db command and AFB_AUTO_MIGRATE.',
		schema: optional
	},
	AFB_AUTO_MIGRATE: {
		description:
			'Set to 1 to run migrations at start (local and preview). Deployments run the db command instead.',
		schema: (value) => value === '1'
	},
	EMAIL_PROVIDER: {
		description: 'log, resend, postmark or smtp. A deployment must choose one on purpose.',
		schema: (value) => {
			const v = optional(value) ?? 'log';
			if (!['log', 'resend', 'postmark', 'smtp'].includes(v))
				throw new Error('EMAIL_PROVIDER must be log, resend, postmark or smtp');
			return v as 'log' | 'resend' | 'postmark' | 'smtp';
		}
	},
	EMAIL_FROM: {
		description: 'The From address of every email, for example board@example.com.',
		schema: (value) => optional(value) ?? 'Agent Flow Board <board@localhost>'
	},
	RESEND_API_KEY: {
		description: 'Resend API key when EMAIL_PROVIDER is resend.',
		schema: optional
	},
	POSTMARK_TOKEN: {
		description: 'Postmark server token when EMAIL_PROVIDER is postmark.',
		schema: optional
	},
	SMTP_URL: {
		description: 'smtp://user:pass@host:587 when EMAIL_PROVIDER is smtp.',
		schema: optional
	},
	AFB_OUTBOX_FILE: {
		description:
			'The log sender appends each mail to this file as a JSON line (development and checks).',
		schema: optional
	},
	AFB_MAIL_FAIL_PATTERN: {
		description:
			'The log sender refuses addresses matching this pattern (checks of the failed send path).',
		schema: optional
	},
	GOOGLE_CLIENT_ID: {
		description: 'Google sign in client id. Google sign in is off while this is unset.',
		schema: optional
	},
	GOOGLE_CLIENT_SECRET: { description: 'Google sign in client secret.', schema: optional },
	GITHUB_APP_ID: {
		description:
			'The numeric id of the GitHub App that publishes reference copies. Publishing is off while this or the private key is unset.',
		schema: optional
	},
	GITHUB_APP_SLUG: {
		description:
			'The URL name of the GitHub App (github.com/apps/<slug>), used for the install link.',
		schema: optional
	},
	GITHUB_APP_PRIVATE_KEY: {
		description:
			'The GitHub App private key in PEM form. In an env file write the line breaks as \n.',
		schema: optional
	},
	GITHUB_WEBHOOK_SECRET: {
		description: 'The secret GitHub signs webhooks with. Webhooks are refused while this is unset.',
		schema: optional
	},
	GITHUB_API_URL: {
		description: 'The GitHub API address. Only a test server changes it.',
		schema: (value) => (optional(value) ?? 'https://api.github.com').replace(/\/$/, '')
	},
	GITHUB_WEB_URL: {
		description:
			'The GitHub web address, for install and commit links. Only a test server changes it.',
		schema: (value) => (optional(value) ?? 'https://github.com').replace(/\/$/, '')
	},
	BACKUP_KEY: {
		description:
			'At least 32 characters. Encrypts every backup. Nightly backups are off while this is unset. Lose it and the backups cannot be read.',
		schema: (value) => {
			const v = optional(value);
			if (v !== undefined && v.length < 32)
				throw new Error('BACKUP_KEY must be at least 32 characters');
			return v;
		}
	},
	AFB_MASTER_KEY: {
		description:
			"At least 32 characters. Wraps each organisation's secret key, which seals the test account passwords browser checks sign in with. Browser check secrets are off while this is unset. Keep it out of the database and out of backups.",
		schema: (value) => {
			const v = optional(value);
			if (v !== undefined && v.length < 32)
				throw new Error('AFB_MASTER_KEY must be at least 32 characters');
			return v;
		}
	},
	AFB_RUNNER_QUEUE_MINUTES: {
		description:
			'How long a browser check or UI shots run waits for a runner before it is reported as stuck. Default 10.',
		schema: (value) => {
			const v = optional(value);
			if (v === undefined) return 10;
			const n = Number(v);
			if (!Number.isInteger(n) || n < 1 || n > 240)
				throw new Error('AFB_RUNNER_QUEUE_MINUTES must be 1 to 240');
			return n;
		}
	},
	BACKUP_DIR: {
		description:
			'Folder for backups when no BACKUP_S3 settings are given. Keep it on a different disk from the data.',
		schema: optional
	},
	BACKUP_S3_ENDPOINT: { description: 'S3 compatible endpoint for backups.', schema: optional },
	BACKUP_S3_BUCKET: { description: 'S3 bucket for backups.', schema: optional },
	BACKUP_S3_ACCESS_KEY_ID: { description: 'S3 access key id for backups.', schema: optional },
	BACKUP_S3_SECRET_ACCESS_KEY: { description: 'S3 secret for backups.', schema: optional },
	DATABASE_BACKUP_URL: {
		description:
			'PostgreSQL connection as a role that bypasses row level security, used only by backups and restores. Required with BACKUP_KEY on PostgreSQL.',
		schema: optional
	},
	AFB_BACKUP_HOUR: {
		description: 'The hour (UTC, 0 to 23) the nightly backup starts. Default 2.',
		schema: (value) => {
			const v = optional(value);
			if (v === undefined) return 2;
			const n = Number(v);
			if (!Number.isInteger(n) || n < 0 || n > 23)
				throw new Error('AFB_BACKUP_HOUR must be 0 to 23');
			return n;
		}
	},
	AFB_PWNED_CHECK: {
		description: 'Set to 0 to skip the breached password check (local checks only).',
		schema: (value) => value !== '0'
	},
	AFB_RATE_LIMIT: {
		description: 'Set to 0 to turn off request limits (local checks that sign in many times).',
		schema: (value) => value !== '0'
	}
});
