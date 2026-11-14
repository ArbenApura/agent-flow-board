// THE OPENAPI DOCUMENT, GENERATED FROM THE ROUTE TABLE AND ITS ZOD SCHEMAS (5.10)

// IMPORTED DEP-MODULES
import { z } from 'zod';
// IMPORTED MODULES
import { routes } from './routes';

// -- FUNCTIONS -- //

const schemaOf = (s: z.ZodType | undefined) => {
	if (!s) return undefined;
	try {
		return z.toJSONSchema(s, { unrepresentable: 'any', io: 'input' });
	} catch {
		return { type: 'object' };
	}
};

/** One document for every endpoint. It never contains a secret or a server setting. */
export function buildOpenApi(baseUrl: string) {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const r of routes) {
		const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
			name: m[1],
			in: 'path',
			required: true,
			schema: { type: 'string' }
		}));
		const query = r.query
			? Object.entries(
					(schemaOf(r.query) as { properties?: Record<string, unknown> }).properties ?? {}
				).map(([name, schema]) => ({ name, in: 'query', required: false, schema }))
			: [];
		const op: Record<string, unknown> = {
			summary: r.summary,
			tags: [r.tag],
			parameters: [
				...params,
				...query,
				{
					name: 'Idempotency-Key',
					in: 'header',
					required: false,
					schema: { type: 'string' },
					description:
						'Repeating a write with the same key returns the first result and writes nothing twice.'
				}
			],
			responses: {
				'200': { description: 'The result' },
				'400': { description: 'Invalid input' },
				'401': { description: 'Not signed in' },
				'403': { description: 'Your role or token does not allow this' },
				'404': { description: 'Not found, or not visible to you' },
				'409': { description: 'A stale write, a closed rule such as COMPLETED, or a conflict' },
				'429': { description: 'Rate limited' }
			},
			security: r.sessionOnly ? [{ cookie: [] }] : [{ bearer: [] }, { cookie: [] }]
		};
		if (r.body)
			op.requestBody = {
				required: true,
				content: { 'application/json': { schema: schemaOf(r.body) } }
			};
		if (r.upload)
			op.requestBody = {
				required: true,
				content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } }
			};
		(paths[r.path] ??= {})[r.method.toLowerCase()] = op;
	}
	return {
		openapi: '3.1.0',
		info: {
			title: 'Agent Flow Board API',
			version: '1.0.0',
			description:
				'Every endpoint calls the same operations layer as the web app and the MCP server.'
		},
		servers: [{ url: `${baseUrl}/api/v1` }],
		paths,
		components: {
			securitySchemes: {
				bearer: {
					type: 'http',
					scheme: 'bearer',
					description:
						'A personal access token (afb_...). Its permissions are limited by your role today.'
				},
				cookie: { type: 'apiKey', in: 'cookie', name: 'afb.session_token' }
			}
		}
	};
}
