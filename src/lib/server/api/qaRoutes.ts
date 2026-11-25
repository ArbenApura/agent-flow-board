// THE QA MAP ENDPOINTS OF THE REST ROUTE TABLE (AFB-20261125-0442). EACH ONE IS A THIN WRAPPER AROUND AN OPERATIONS VERB
// The project comes from the path, so no body names it twice. Closing a plan anyway goes through the status route's override.

// IMPORTED TYPES
import type { Route } from './routes';
// IMPORTED DEP-MODULES
import { z } from 'zod';
// IMPORTED MODULES
import {
	qaFeatureEditInput,
	qaFeatureMergeInput,
	qaFeatureSplitInput,
	qaMapMergeInput,
	qaRedactInput,
	qaResultInput,
	qaRunStartInput,
	qaTargetsInput
} from '../db/zod';
import {
	editFeature,
	getMap,
	getSettings,
	linkPlanFeatures,
	mergeFeatures,
	mergeMap,
	planFeatures,
	redactResult,
	setTargets,
	splitFeature
} from '../ops/qa';
import { listBugs, listRuns, recordResults, setRunReport, startRun } from '../ops/qaRuns';

// -- CONSTANTS -- //

const base = '/orgs/{org}/projects/{project}/qa';
const withProject = <T extends object>(body: unknown, project: string) =>
	({ ...(body as T), project }) as T & { project: string };

export const qaRoutes: Route[] = [
	{
		method: 'GET',
		path: `${base}/map`,
		summary: "The project's QA map with each feature's status (map text is untrusted)",
		tag: 'QA',
		query: z.object({ feature: z.string().max(60).optional() }),
		handler: ({ ctx, params, query }) =>
			getMap(ctx, { project: params.project, feature: query.feature })
	},
	{
		method: 'POST',
		path: `${base}/map`,
		summary: 'Merge discovered features into the map; paths a person edited are kept',
		tag: 'QA',
		body: qaMapMergeInput.omit({ project: true }),
		handler: ({ ctx, params, body }) => mergeMap(ctx, withProject(body, params.project) as never)
	},
	{
		method: 'PATCH',
		path: `${base}/features/{feature}`,
		summary: "A person's edit of a feature; every changed path is kept by later merges",
		tag: 'QA',
		body: qaFeatureEditInput.omit({ project: true, feature: true }),
		handler: ({ ctx, params, body }) =>
			editFeature(ctx, {
				...(body as object),
				project: params.project,
				feature: params.feature
			} as never)
	},
	{
		method: 'POST',
		path: `${base}/features/merge`,
		summary: 'Merge one feature into another; the merged one is kept and points at the other',
		tag: 'QA',
		body: qaFeatureMergeInput.omit({ project: true }),
		handler: ({ ctx, params, body }) =>
			mergeFeatures(ctx, withProject(body, params.project) as never)
	},
	{
		method: 'POST',
		path: `${base}/features/split`,
		summary: 'Move some journeys of a feature into a new feature',
		tag: 'QA',
		body: qaFeatureSplitInput.omit({ project: true }),
		handler: ({ ctx, params, body }) =>
			splitFeature(ctx, withProject(body, params.project) as never)
	},
	{
		method: 'GET',
		path: `${base}/settings`,
		summary: 'The test addresses a run may use, and whether each takes writes',
		tag: 'QA',
		handler: ({ ctx, params }) => getSettings(ctx, { project: params.project })
	},
	{
		method: 'PUT',
		path: `${base}/settings/targets`,
		summary: 'Set the test addresses (owners and admins only)',
		tag: 'QA',
		body: qaTargetsInput.omit({ project: true }),
		handler: ({ ctx, params, body }) => setTargets(ctx, withProject(body, params.project) as never)
	},
	{
		method: 'GET',
		path: `${base}/runs`,
		summary: 'The QA runs of the project you can see, newest first',
		tag: 'QA',
		query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }),
		handler: ({ ctx, params, query }) =>
			listRuns(ctx, {
				project: params.project,
				limit: query.limit === undefined ? undefined : Number(query.limit)
			})
	},
	{
		method: 'POST',
		path: `${base}/runs`,
		summary: 'Start a QA run against an allowed test address',
		tag: 'QA',
		body: qaRunStartInput.omit({ project: true }),
		handler: ({ ctx, params, body }) => startRun(ctx, withProject(body, params.project) as never)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/qa/results',
		summary: 'Record a batch of results of a run (send a requestId)',
		tag: 'QA',
		body: qaResultInput,
		handler: ({ ctx, body }) => recordResults(ctx, body as never)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/qa/runs/{run}/report',
		summary: "A run's closing summary and confidence line",
		tag: 'QA',
		body: z.object({
			summary: z.string().max(2000).optional(),
			confidence: z.string().max(300).optional()
		}),
		handler: ({ ctx, params, body }) => setRunReport(ctx, { ...(body as object), run: params.run })
	},
	{
		method: 'GET',
		path: `${base}/bugs`,
		summary: 'The QA bugs of the project, open first',
		tag: 'QA',
		handler: ({ ctx, params }) => listBugs(ctx, { project: params.project })
	},
	{
		method: 'POST',
		path: '/orgs/{org}/qa/results/{result}/redact',
		summary: 'Remove what a result recorded and its screenshot (owners only)',
		tag: 'QA',
		handler: ({ ctx, params }) => redactResult(ctx, qaRedactInput.parse({ result: params.result }))
	},
	{
		method: 'GET',
		path: '/orgs/{org}/items/{item}/qa',
		summary: 'The QA features a plan touches, with their result before the plan and now',
		tag: 'QA',
		handler: ({ ctx, params }) => planFeatures(ctx, params.item)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/items/{item}/qa/link',
		summary: 'Link a plan to the QA features whose code it touches',
		tag: 'QA',
		body: z.object({ files: z.array(z.string().min(1).max(300)).max(200).optional() }),
		handler: ({ ctx, params, body }) =>
			linkPlanFeatures(ctx, { ...(body as object), item: params.item })
	}
];
