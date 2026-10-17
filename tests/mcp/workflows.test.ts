// THE SERVED WORKFLOW TEXT CARRIES THE PROGRESS FIRST RULE FOR EVERY TOOL

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import { WORKFLOWS, workflowByName } from '../../src/lib/server/mcp/workflows';

// -- TESTS -- //

describe('workflow text', () => {
	it('serves the progress first rule in the flow workflow', () => {
		const flow = workflowByName('flow');
		expect(flow?.body).toContain('Progress first');
		expect(flow?.body).toContain('before you start the next one');
		expect(flow?.body).toContain('item_get');
	});

	it('shares the rule with every workflow through the common rules', () => {
		for (const w of WORKFLOWS) {
			if (w.name === 'flow-task') continue;
			expect(w.body, w.name).toContain('Progress first');
		}
	});

	it('has the audit report finished work that was never recorded', () => {
		expect(workflowByName('flow-audit')?.body).toContain('no step_done');
	});
});
