// A THROWAWAY POSTGRESQL FOR THE BUILD PREVIEW (ADR-017): THE SAME EMBEDDED SERVER THE UNIT TESTS USE, STARTED FOR ONE RUN
// The app needs a PostgreSQL to start. The preview used to fall back to an in-memory PGlite database; now it gets its own server
// on a free port with an empty database, and the app migrates it at start (AFB_AUTO_MIGRATE in .env.test). The login is the
// superuser, so the app switches to the app_runtime role in each transaction and forced row level security applies.
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function freePort() {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.listen(0, () => {
			const port = s.address().port;
			s.close(() => resolve(port));
		});
		s.on('error', reject);
	});
}

/** Starts the server and returns its DATABASE_URL and a function that stops it and removes its folder. */
export async function startDatabase() {
	const dir = mkdtempSync(join(tmpdir(), 'afb-preview-pg-'));
	const port = await freePort();
	const server = new EmbeddedPostgres({
		databaseDir: dir,
		user: 'postgres',
		password: 'pw',
		port,
		persistent: false,
		onLog: () => {},
		onError: () => {}
	});
	await server.initialise();
	await server.start();
	await server.createDatabase('afb');
	return {
		url: `postgres://postgres:pw@localhost:${port}/afb`,
		stop: async () => {
			// The server removes its own data folder when it stops, and on Windows that can briefly fail with EBUSY
			try {
				await server.stop();
			} catch {
				/* The folder is removed below */
			}
			try {
				rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
			} catch {
				/* The operating system removes the temp folder later */
			}
		}
	};
}
