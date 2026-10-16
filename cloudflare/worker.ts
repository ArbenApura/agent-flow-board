// THE CLOUDFLARE WORKER: THE SVELTEKIT APP, THE QUEUE CONSUMER FOR BACKGROUND JOBS, AND THE DURABLE OBJECT THAT FANS OUT LIVE UPDATES (SPEC 4)
// `yarn build:cloudflare` builds the app into .svelte-kit/cloudflare (wrangler.adapter.jsonc says where). wrangler bundles this file with it.
// The queue consumer imports no app code: it hands each job back to the app over an internal route, signed with a key only the app
// holds, so the job runs in the same request pipeline as everything else (the same bindings, the same tenant rules).

// -- DEP-MODULES -- //
// @ts-expect-error The file is written by `yarn build:cloudflare`
import app from '../.svelte-kit/cloudflare/_worker.js';
// -- MODULES -- //
import { HubObject as Hub } from '../src/lib/server/cloudflare/hub';
import { signBody } from '../src/lib/server/cloudflare/sign';

// -- TYPES -- //

type Env = { AFB_BASE_URL: string; BETTER_AUTH_SECRET: string } & Record<string, unknown>;
type Message = { body: unknown; ack(): void; retry(options?: { delaySeconds?: number }): void };
type Ctx = { waitUntil(p: Promise<unknown>): void };

// -- FUNCTIONS -- //

/** The Durable Object class the wrangler configuration binds as AFB_HUB. */
export class HubObject extends Hub {}

export default {
	fetch: (request: Request, env: Env, ctx: Ctx): Promise<Response> => app.fetch(request, env, ctx),

	/** Runs each queued job through the app. A job that fails is retried by the queue, up to its limit. */
	async queue(batch: { messages: Message[] }, env: Env, ctx: Ctx): Promise<void> {
		for (const message of batch.messages) {
			const body = JSON.stringify(message.body);
			const res = await app.fetch(
				new Request(`${env.AFB_BASE_URL.replace(/\/$/, '')}/internal/jobs`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-afb-signature': await signBody(env.BETTER_AUTH_SECRET, body)
					},
					body
				}),
				env,
				ctx
			);
			if (res.ok) message.ack();
			else message.retry({ delaySeconds: 30 });
		}
	}
};
