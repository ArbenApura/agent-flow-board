// STALE WHILE REVALIDATE FOR THE ROUTER'S DATA REQUESTS (ADR-020, FLOW-20261016-0935 13.5)
// It is a plain script that runs before the app, because SvelteKit keeps the window.fetch of that moment for its own data requests.
// The cache keeps the data of each node of a route (the root layout, the organisation layout, the page...) on its own, so a visit
// is answered from memory whenever every node it needs has been seen before, whichever nodes the router asked for. The answer is
// shown at once and the same request refreshes in the background. A reload the live hub asked for clears the cache first, and
// any write clears it too, so nobody ever sees their own change missing.
(function () {
	var MAX_NODES = 240;
	// A node refreshed this recently is trusted as is, so one navigation does not refetch in a loop
	var FRESH_MS = 300;
	var DATA = /\/__data\.json$/;
	var cache = new Map();
	var refreshing = new Set();
	var state = { onChange: null };
	// Counts the clearings. An answer that was asked for before a clearing is never stored after it, because it may predate a write
	var generation = 0;
	function clearAll() {
		generation++;
		cache.clear();
	}
	var real = window.fetch.bind(window);

	function remember(key, text) {
		cache.delete(key);
		cache.set(key, { text: text, at: Date.now() });
		// The oldest node goes first once the limit is passed
		while (cache.size > MAX_NODES) cache.delete(cache.keys().next().value);
	}
	/**
	 * Where one node's data is kept. A layout node belongs to the part of the address it covers (the organisation layout to
	 * /acme, the project layout to /acme/CKT), so every page under it shares it. The page node belongs to the whole address and
	 * its query. This follows the shape of the routes: the root layout first, the page last.
	 */
	function nodeKey(base, index, count) {
		if (index === count - 1) return 'P:' + base.path;
		return 'L' + index + ':/' + base.segs.slice(0, index).join('/');
	}
	/** Stores every data node of a response. Returns true when one of the nodes in `needed` differs from what was held. */
	function store(base, body, needed, asked) {
		var changed = false;
		if (asked !== generation) return false;
		// An error or a redirect means this person may no longer see what was cached (removed, signed out, another person), so
		// nothing is kept and the page is told to load again from the network
		var bad =
			!body ||
			body.type !== 'data' ||
			!Array.isArray(body.nodes) ||
			body.nodes.some(function (n) {
				return n && n.type !== 'data' && n.type !== 'skip';
			});
		if (bad) {
			clearAll();
			return true;
		}
		var nodes = body.nodes;
		nodes.forEach(function (node, i) {
			if (!node || node.type !== 'data') return;
			var key = nodeKey(base, i, nodes.length);
			var text = JSON.stringify(node);
			var old = cache.get(key);
			if (needed && needed.indexOf(i) >= 0 && old && old.text !== text) changed = true;
			remember(key, text);
		});
		return changed;
	}

	window.__afbSwr = {
		clear: clearAll,
		size: function () {
			return cache.size;
		},
		onChange: function (fn) {
			state.onChange = fn;
		}
	};

	window.fetch = async function (input, init) {
		var req = new Request(input, init);
		var url = new URL(req.url, location.href);
		var sameOrigin = url.origin === location.origin;
		// A write of any kind clears everything the cache holds
		if (req.method !== 'GET' && sameOrigin) {
			// A write clears the cache when it starts and again when it has finished, because a read that began in between
			// may have been answered before the write committed
			clearAll();
			return real(input, init).finally(clearAll);
		}
		if (req.method !== 'GET' || !sameOrigin || !DATA.test(url.pathname)) return real(input, init);
		var asked = generation;
		var flags = url.searchParams.get('x-sveltekit-invalidated');
		// The page's own query (a search word, a filter) is part of what the data is, so it is part of the key
		var params = new URLSearchParams(url.search);
		params.delete('x-sveltekit-invalidated');
		params.sort();
		var base = {
			path: url.pathname + '?' + params.toString(),
			segs: url.pathname.replace(/\/__data\.json$/, '').split('/').filter(Boolean)
		};
		var needed = [];
		if (flags) for (var i = 0; i < flags.length; i++) if (flags[i] === '1') needed.push(i);
		var held = needed.map(function (i) {
			return cache.get(nodeKey(base, i, flags.length));
		});
		var complete = flags && needed.length > 0 && held.every(Boolean);
		if (!complete) {
			var res = await real(input, init);
			if (res.ok)
				res
					.clone()
					.json()
					.then(function (b) {
						store(base, b, null, asked);
					})
					.catch(function () {});
			return res;
		}
		// Stale while revalidate. A node refreshed a moment ago is not asked for again
		var stale = held.some(function (h) {
			return Date.now() - h.at > FRESH_MS;
		});
		var key = url.pathname + url.search;
		if (stale && !refreshing.has(key)) {
			refreshing.add(key);
			real(input, init)
				.then(async function (res) {
					if (!res.ok) {
						if (asked === generation) {
							clearAll();
							if (state.onChange) state.onChange();
						}
						return;
					}
					if (store(base, await res.json(), needed, asked) && state.onChange) state.onChange();
				})
				.catch(function () {})
				.finally(function () {
					refreshing.delete(key);
				});
		}
		var nodes = [];
		for (var n = 0; n < flags.length; n++)
			nodes.push(flags[n] === '1' ? JSON.parse(held[needed.indexOf(n)].text) : { type: 'skip' });
		return new Response(JSON.stringify({ type: 'data', nodes: nodes }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	};
})();
