// DATABASE COMMANDS: yarn db migrate | seed [--load N]
// Without DATABASE_URL this uses a PGlite folder in .afb/dev-db, the local development database (3.9).
import { mkdirSync } from 'node:fs';
import { createPglite, createPostgres } from '../src/lib/server/db/client';
import { migrate } from '../src/lib/server/db/migrate';
import { seedDemo } from '../src/lib/server/db/seed';

const [command, ...rest] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (url && command === 'seed' && !process.env.AFB_ALLOW_SEED_REMOTE) {
	console.error(
		'Refusing to seed a remote database. Set AFB_ALLOW_SEED_REMOTE=1 only for a throwaway test server.'
	);
	process.exit(1);
}
// Only the local PGlite database needs a folder. A server image may not be able to write to its working folder
if (!url) mkdirSync('.afb', { recursive: true });
const handle = url ? await createPostgres({ ownerUrl: url }) : await createPglite('.afb/dev-db');
try {
	if (command === 'migrate') {
		const applied = await migrate(handle.owner);
		console.log(applied.length ? `Applied ${applied.join(', ')}` : 'Already up to date');
		// A server gives the runtime role a login here. The password is written into the statement, so it must be a plain token
		const runtimePassword = process.env.AFB_RUNTIME_PASSWORD;
		if (url && runtimePassword) {
			if (!/^[A-Za-z0-9_.~-]{16,}$/.test(runtimePassword)) {
				console.error('AFB_RUNTIME_PASSWORD must be 16 or more letters, digits or _ . ~ -');
				process.exit(1);
			}
			await handle.owner.exec(`ALTER ROLE app_runtime LOGIN PASSWORD '${runtimePassword}'`);
			console.log('The app_runtime role can log in.');
		}
	} else if (command === 'seed') {
		await migrate(handle.owner);
		const load = rest.includes('--load') ? Number(rest[rest.indexOf('--load') + 1]) : 5000;
		const ids = await seedDemo(handle.owner, { loadItems: load });
		console.log(`Seeded ${load} load items. Acme org ${ids.acme}, Lumora org ${ids.lumora}.`);
	} else {
		console.error('Usage: yarn db migrate | seed [--load N]');
		process.exitCode = 1;
	}
} finally {
	await handle.close();
}
