// A PROBE THAT RUNS DURING A DEPLOY AND COUNTS EVERY FAILED REQUEST: node deploy/vps/probe.mjs [url] [seconds]
// Every 200 ms it sends GET /healthz, and a POST to /mcp. A request counts as failed when it does not answer in time, answers 5xx,
// or (for /healthz) does not say ok. The /mcp call needs no token to prove the path from the proxy to the app: an unauthenticated
// call answers 401 from the app itself, which is a success here. Set AFB_PROBE_TOKEN to also make an authenticated tools/list call
// (the token is read from the environment only and is never printed). Exit code 1 when anything failed.

// -- CONSTANTS -- //

const url = (process.argv[2] ?? 'https://afb.arbenger.com').replace(/\/$/, '');
const seconds = Number(process.argv[3] ?? 120);
const INTERVAL_MS = 200;
const TIMEOUT_MS = 20_000;
const token = process.env.AFB_PROBE_TOKEN ?? '';

// -- STATES -- //

const counts = { sent: 0, failed: 0 };
const failures = [];
const started = Date.now();

// -- FUNCTIONS -- //

async function call(name, path, init, ok) {
	counts.sent++;
	const at = ((Date.now() - started) / 1000).toFixed(1);
	try {
		const res = await fetch(url + path, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
		const text = await res.text();
		if (!ok(res, text)) throw new Error(`HTTP ${res.status}`);
	} catch (e) {
		counts.failed++;
		if (failures.length < 50)
			failures.push(`${at}s ${name}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

function tick() {
	void call('healthz', '/healthz', {}, (res, text) => res.ok && /"ok":\s*true/.test(text));
	const mcp = {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
	};
	void call('mcp (no token)', '/mcp', mcp, (res) => res.status < 500);
	if (token)
		void call(
			'mcp (token)',
			'/mcp',
			{ ...mcp, headers: { ...mcp.headers, authorization: `Bearer ${token}` } },
			(res, text) => res.ok && text.includes('tools')
		);
}

// -- RUN -- //

console.log(
	`Probing ${url} every ${INTERVAL_MS} ms for ${seconds} s${token ? ' (with a token)' : ''}`
);
const timer = setInterval(tick, INTERVAL_MS);
setTimeout(() => {
	clearInterval(timer);
	// A last moment for the requests still in flight
	setTimeout(() => {
		console.log(`Sent ${counts.sent}, failed ${counts.failed}`);
		for (const f of failures) console.log(`  ${f}`);
		process.exit(counts.failed ? 1 : 0);
	}, 2000);
}, seconds * 1000);
