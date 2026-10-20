// THE SERVED WORKFLOW TEXT CARRIES THE PROGRESS FIRST RULE FOR EVERY TOOL

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	WORKFLOWS,
	WORKFLOW_FILE_NAMES,
	workflowByName,
	workflowFile
} from '../../src/lib/server/mcp/workflows';

// -- TESTS -- //

describe('workflow text', () => {
	it('serves the progress first rule in the flow workflow', () => {
		const flow = workflowByName('flow');
		expect(flow?.body).toContain('Progress first');
		expect(flow?.body).toContain('PROGRESS FIRST');
		expect(flow?.body).toContain('step_done');
		expect(flow?.body).toContain('item_get');
	});

	it('serves the AFB skills first, with the standing overrides, and the shared rules after them', () => {
		// flow-check and flow-verify are tools, not planning workflows: flow-check runs the browser checks that the planning overrides skip
		const tools = ['flow-check', 'flow-verify'];
		for (const w of WORKFLOWS) {
			if (!tools.includes(w.name)) expect(w.body, w.name).toContain('Standing AFB overrides');
			expect(w.body, w.name).not.toContain('allowed-tools');
			expect(w.body.startsWith('> This workflow is the Agent Flow Board one'), w.name).toBe(true);
		}
		const flow = workflowByName('flow')!.body;
		expect(flow.indexOf('Standing AFB overrides')).toBeLessThan(
			flow.indexOf('## Rules that apply')
		);
	});

	it('has the critic supporting files readable by name', () => {
		for (const f of WORKFLOW_FILE_NAMES) expect(workflowFile(f).length, f).toBeGreaterThan(500);
	});

	it('tells the critic prompt to read its supporting files first, in parts, before any subagent', () => {
		const body = workflowByName('flow-critic')!.body;
		// The note comes first, ahead of the critic text
		const note = body.indexOf('First action');
		expect(note).toBeGreaterThan(-1);
		expect(note).toBeLessThan(body.indexOf('# Flow Critic'));
		for (const f of WORKFLOW_FILE_NAMES) expect(body, f).toContain(f);
		expect(body).toContain('workflow_get name flow-critic and file');
		expect(body).toContain('Plan mode: read plan-template and plan-lenses');
		expect(body).toContain('Code mode: read code-template, code-lenses and checklists');
		expect(body).toContain('offset');
		expect(body).toContain('Do not dispatch any subagent until the files for your mode are read');
		// A built-in refuses file on skill_get, so the note must not send the model there
		expect(body.slice(note, body.indexOf('# Flow Critic'))).not.toContain('skill_get');
	});

	it('shares the rule with every workflow through the common rules', () => {
		for (const w of WORKFLOWS) {
			if (w.name === 'flow-task') continue;
			expect(w.body, w.name).toContain('Progress first');
		}
	});

	it('has the audit report finished work that was never recorded', () => {
		expect(workflowByName('flow-audit')?.body).toContain('NOT RECORDED');
		expect(workflowByName('flow-audit')?.body).toContain('step_done');
	});
});
