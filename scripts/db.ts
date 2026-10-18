// DATABASE COMMANDS: yarn db migrate | seed [--load N]
// DATABASE_URL is required: the PostgreSQL database to change, logged in as its owner (for local work see yarn db:local:migrate).
import { createPostgres } from '../src/lib/server/db/client';
import { migrate } from '../src/lib/server/db/migrate';
import { seedDemo } from '../src/lib/server/db/seed';

const [command, ...rest] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) {
	console.error('DATABASE_URL is required: the PostgreSQL database to run this command on.');
	process.exit(1);
}
if (command === 'seed' && !process.env.AFB_ALLOW_SEED_REMOTE) {
	console.error(
		'Refusing to seed a remote database. Set AFB_ALLOW_SEED_REMOTE=1 only for a throwaway test server.'
	);
	process.exit(1);
}
const handle = await createPostgres({ ownerUrl: url });
try {
	if (command === 'migrate') {
		const applied = await migrate(handle.owner);
		console.log(applied.length ? `Applied ${applied.join(', ')}` : 'Already up to date');
		// A server gives the runtime role a login here. The password is written into the statement, so it must be a plain token
		const runtimePassword = process.env.AFB_RUNTIME_PASSWORD;
		if (runtimePassword) {
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
