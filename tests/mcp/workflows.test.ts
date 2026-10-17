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
		for (const w of WORKFLOWS) {
			expect(w.body, w.name).toContain('Standing AFB overrides');
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
		expect(workflowByName('flow-critic')?.body).toContain('workflow_get name flow-critic and file');
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
