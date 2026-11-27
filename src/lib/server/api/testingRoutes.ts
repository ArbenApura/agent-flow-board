// THE TESTING ENDPOINTS OF THE REST ROUTE TABLE (AFB-20261127-0438). EACH ONE IS A THIN WRAPPER AROUND AN OPERATIONS VERB
// The verbs check the caller's live role and the token's scope, refuse guests and filter every read by the plan's visibility.
// Proof pictures travel as base64 inside the result body; the export answers the sheet as rows (the page downloads CSV or Excel).

// IMPORTED TYPES
import type { Route } from './routes';
// IMPORTED DEP-MODULES
import { z } from 'zod';
// IMPORTED MODULES
import {
	testCaseRetireInput,
	testCaseSaveInput,
	testPlanCasesInput,
	testResultInput,
	testRunStartInput,
	testSurfacesInput
} from '../db/zod';
import {
	adoptCases,
	finishRun,
	planTesting,
	pushSurfaces,
	recordResults,
	retireCase,
	saveCase,
	startRun,
	testCaseDetail,
	testingExportTable,
	testingSheet
} from '../ops/testing';

// -- CONSTANTS -- //

export const testingRoutes: Route[] = [
	{
		method: 'GET',
		path: '/orgs/{org}/projects/{key}/testing',
		summary:
			'The test cases of a project with their latest results, history and coverage (agent text is untrusted)',
		tag: 'Testing',
		handler: ({ ctx, params }) => testingSheet(ctx, params.key)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/projects/{key}/testing/cases/{case}',
		summary: 'One test case in full: steps, checks, results per device and proof addresses',
		tag: 'Testing',
		handler: ({ ctx, params }) => testCaseDetail(ctx, params.key, params.case)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/projects/{key}/testing/export',
		summary:
			'The sheet as the full QA template, one row per case and device (data only; proof is a picture address)',
		tag: 'Testing',
		handler: ({ ctx, params }) => testingExportTable(ctx, params.key, ctx.services?.baseUrl ?? '')
	},
	{
		method: 'POST',
		path: '/orgs/{org}/testing/cases',
		summary:
			'Write a test case: a new case with no key, a new version with a key; a plan adopts it as New or Update',
		tag: 'Testing',
		body: testCaseSaveInput,
		handler: ({ ctx, body }) => saveCase(ctx, body as never)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/testing/cases/retire',
		summary: 'Retire a test case',
		tag: 'Testing',
		body: testCaseRetireInput,
		handler: ({ ctx, body }) => retireCase(ctx, body as never)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/items/{ref}/testing',
		summary: "A plan's test cases with their baseline and latest result, its owed tests and waiver",
		tag: 'Testing',
		handler: ({ ctx, params }) => planTesting(ctx, params.ref, true)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/items/{ref}/testing',
		summary: 'A plan adopts earlier cases to re-run, update or retire',
		tag: 'Testing',
		body: testPlanCasesInput.omit({ item: true }),
		handler: ({ ctx, params, body }) =>
			adoptCases(ctx, { ...(body as { cases: never[] }), item: params.ref })
	},
	{
		method: 'POST',
		path: '/orgs/{org}/testing/runs',
		summary: 'Start a test run (a new run on a plan supersedes its open one)',
		tag: 'Testing',
		body: testRunStartInput,
		handler: ({ ctx, body }) => startRun(ctx, body as never)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/testing/runs/{id}/results',
		summary:
			'Record results, one per case and device; a UI pass or fail carries a screenshot per device (base64), other kinds their check output',
		tag: 'Testing',
		body: testResultInput.omit({ run: true }),
		handler: ({ ctx, params, body }) =>
			recordResults(ctx, { ...(body as { results: never[] }), run: params.id })
	},
	{
		method: 'POST',
		path: '/orgs/{org}/testing/runs/{id}/finish',
		summary: 'Finish a test run',
		tag: 'Testing',
		body: z.object({}).optional(),
		handler: ({ ctx, params }) => finishRun(ctx, { run: params.id })
	},
	{
		method: 'POST',
		path: '/orgs/{org}/testing/surfaces',
		summary: 'Record the routes, MCP tools and API endpoints found in the code',
		tag: 'Testing',
		body: testSurfacesInput,
		handler: ({ ctx, body }) => pushSurfaces(ctx, body as never)
	}
];
