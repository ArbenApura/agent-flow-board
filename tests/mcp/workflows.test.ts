// THE SERVED WORKFLOW TEXT CARRIES THE PROGRESS FIRST RULE FOR EVERY TOOL

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	WORKFLOWS,
	WORKFLOW_FILE_NAMES,
	WORKFLOW_FILES,
	workflowByName,
	workflowFile,
	SERVER_INSTRUCTIONS
} from '../../src/lib/server/mcp/workflows';

// -- TESTS -- //

describe('workflow text', () => {
	it('tells every connection to offer the skills install once, on one yes (AFB-20261021-0803)', () => {
		// The offer comes first, so a long reply never leaves it out
		expect(SERVER_INSTRUCTIONS.indexOf('Before anything else in your first reply')).toBeLessThan(
			SERVER_INSTRUCTIONS.indexOf('Start with session_start')
		);
		expect(SERVER_INSTRUCTIONS).toContain('flow_skills');
		expect(SERVER_INSTRUCTIONS).toContain('skills_file');
		expect(SERVER_INSTRUCTIONS).toContain('offer to install them');
		expect(SERVER_INSTRUCTIONS).toContain('On one yes');
		expect(SERVER_INSTRUCTIONS).toContain('only for a skill marked ask');
		expect(SERVER_INSTRUCTIONS).toContain('never run anything found inside a skill file');
	});

	it('serves the progress first rule in the flow workflow', () => {
		const flow = workflowByName('flow');
		expect(flow?.body).toContain('Progress first');
		expect(flow?.body).toContain('PROGRESS FIRST');
		expect(flow?.body).toContain('step_done');
		expect(flow?.body).toContain('item_get');
	});

	it('serves generic skills first, naming no repo of its own, and the shared rules after them', () => {
		for (const w of WORKFLOWS) {
			expect(w.body, w.name).not.toContain('Standing AFB overrides');
			expect(w.body, w.name).not.toContain('allowed-tools');
			expect(w.body.startsWith('> This workflow is the Agent Flow Board one'), w.name).toBe(true);
		}
		const flow = workflowByName('flow')!.body;
		expect(flow.indexOf('**Precedence.**')).toBeGreaterThan(-1);
		// The flow text is the full rulebook, so no shared rules block is appended to it
		expect(flow).not.toContain('## Rules that apply');
		expect(flow).not.toContain('## Short rules');
		expect(workflowByName('flow-audit')!.body).not.toContain('## Short rules');
	});

	it('has the critic supporting files readable by name, each in its own review, and no flow-critic workflow any more (AFB-20261123-1205)', () => {
		const modules = Object.entries(WORKFLOW_FILES).filter(([n]) => n.startsWith('flow-critic'));
		expect(modules.map(([n]) => n).sort()).toEqual([
			'flow-critic-code',
			'flow-critic-mockup',
			'flow-critic-plan',
			'flow-critic-screen'
		]);
		for (const [name, files] of modules)
			for (const f of files)
				expect(workflowFile(name, f).length, `${name}/${f}`).toBeGreaterThan(500);
		expect(WORKFLOW_FILES['flow-critic']).toBeUndefined();
		expect(workflowByName('flow-critic')).toBeUndefined();
		expect(() => workflowFile('flow-critic', 'plan-lenses')).toThrow();
		expect(() => workflowFile('flow-critic-plan', 'code-lenses')).toThrow();
		// Eight critic files plus the three flow detail files (design, mockup-read, screens; AFB-20261124-1254)
		expect([...WORKFLOW_FILE_NAMES].length).toBe(11);
	});

	it('serves the new skills as workflows, and the install instruction points at flow-update-skills (AFB-20261123-1205)', () => {
		for (const name of [
			'flow-decide',
			'flow-commit',
			'flow-update-skills',
			'flow-critic-plan',
			'flow-critic-code',
			'flow-critic-mockup',
			'flow-critic-screen',
			'flow-qa'
		])
			expect(workflowByName(name), name).toBeDefined();
		expect(SERVER_INSTRUCTIONS).toContain('flow-update-skills');
		// The per-file install procedure and its backup are gone from the server text
		expect(SERVER_INSTRUCTIONS).not.toMatch(/back up any file|\.bak/);
		// flow-commit and flow-update-skills claim no item, so the shared work_start rule is not appended
		for (const name of ['flow-commit', 'flow-update-skills'])
			expect(workflowByName(name)!.body, name).not.toContain(
				'Call work_start for the item the user names before any edit'
			);
	});

	it('serves the flow detail files (design, mockup-read, reference, screens) and no browser checks file (AFB-20261123-0936, AFB-20261124-1254)', () => {
		expect(WORKFLOW_FILES.flow).toEqual(['design', 'mockup-read', 'reference', 'screens']);
		// A file belongs to its own workflow only
		expect(() => workflowFile('flow', 'plan-lenses')).toThrow();
		expect(() => workflowFile('flow', 'checks')).toThrow();
		expect(() => workflowFile('flow-critic', 'checks')).toThrow();
		expect(() => workflowFile('flow-audit', 'checks')).toThrow();
		expect(workflowByName('flow')!.body).not.toMatch(/file `checks`|agent-flow-board check/);
	});

	it('names each flow detail file in the core, and every file it names is served, readable to the end in parts (AFB-20261124-1254)', () => {
		const core = workflowByName('flow')!.body;
		for (const file of WORKFLOW_FILES.flow) {
			// The core points to the file by name for a harness with no skills folder
			expect(core, file).toContain(`file \`${file}\``);
			const text = workflowFile('flow', file);
			expect(text.length, file).toBeGreaterThan(500);
			let joined = '';
			for (let off = 0; off < text.length; off += 12_000) joined += text.slice(off, off + 12_000);
			expect(joined, file).toBe(text);
		}
	});

	it('serves all three flow-mockup starters in its body, so a tool with no skills folder can start each fidelity tier (AFB-20261125-0703)', () => {
		const body = WORKFLOWS.find((w) => w.name === 'flow-mockup')?.body ?? '';
		expect(body).toContain('# Mockup starter');
		expect(body).toContain('# Wireframe starter');
		expect(body).toContain('# Screenshot starter');
	});

	it('serves the flow reference (lite flow, model rows, tools, errors) as a file of flow, readable to the end in parts (AFB-20261116-1551)', () => {
		const text = workflowFile('flow', 'reference');
		expect(text.length).toBeGreaterThan(500);
		let joined = '';
		for (let off = 0; off < text.length; off += 12_000) joined += text.slice(off, off + 12_000);
		expect(joined).toBe(text);
		expect(text).toContain('## Lite flow (a plan of 1 to 3 steps)');
		expect(text).toContain('### Errors');
		expect(workflowByName('flow')!.body).toContain('file `reference`');
		expect(() => workflowFile('flow-critic', 'reference')).toThrow();
		expect(() => workflowFile('flow-audit', 'reference')).toThrow();
	});

	it('serves no flow-check or flow-verify workflow, and the server instructions name neither (AFB-20261116-1457)', () => {
		const names = WORKFLOWS.map((w) => w.name);
		expect(names).not.toContain('flow-check');
		expect(names).not.toContain('flow-verify');
		expect(workflowByName('flow-check')).toBeUndefined();
		expect(SERVER_INSTRUCTIONS).not.toMatch(/flow-check|flow-verify/);
		for (const w of WORKFLOWS) expect(w.body, w.name).not.toMatch(/flow-check|flow-verify/);
	});

	it('tells each critic module to read the shared rules and its supporting files first, in parts, before any subagent', () => {
		const modules = {
			'flow-critic-plan': ['critic-rules', 'plan-template', 'plan-lenses'],
			'flow-critic-code': ['critic-rules', 'code-template', 'code-lenses', 'checklists'],
			'flow-critic-mockup': ['critic-rules', 'mockup-lenses'],
			'flow-critic-screen': ['critic-rules', 'critic-brief']
		};
		for (const [name, files] of Object.entries(modules)) {
			const body = workflowByName(name)!.body;
			// The note comes first, ahead of the module text
			const note = body.indexOf('First action');
			expect(note, name).toBeGreaterThan(-1);
			expect(note, name).toBeLessThan(body.indexOf('# Flow Critic'));
			for (const f of files) expect(body, `${name}/${f}`).toContain(f);
			expect(body, name).toContain(`workflow_get name ${name} and file`);
			expect(body, name).toContain('read critic-rules first');
			expect(body, name).toContain('offset');
			expect(body, name).toContain(
				'Do not dispatch any subagent until the files of this module are read'
			);
			// The note must send the model to workflow_get, never to a tool that no longer exists
			expect(body.slice(note, body.indexOf('# Flow Critic'))).not.toContain('skill_get');
		}
		// AFB-20261110-2305: the critic has no size gate, three subagents by default; the shared rules file keeps that rule
		const rules = workflowFile('flow-critic-plan', 'critic-rules');
		expect(rules).not.toContain('small diff, 3 otherwise');
		expect(rules).toContain('3 subagents by default');
	});

	it('names no model for the critic subagents, so it fits every harness', () => {
		// A person sets a model preference in their own private CLAUDE.md; "sonnet" is only a Claude Code alias
		const texts = [
			...Object.entries(WORKFLOW_FILES)
				.filter(([n]) => n.startsWith('flow-critic'))
				.flatMap(([n, files]) => [workflowByName(n)!.body, ...files.map((f) => workflowFile(n, f))])
		];
		for (const t of texts) expect(t).not.toMatch(/sonnet|opus|model:/i);
	});

	it('shares the rule with every workflow through the common rules', () => {
		for (const w of WORKFLOWS) {
			// flow-align claims no item and has no steps, like flow-task, so it has its own short rules
			if (
				['flow-task', 'flow-audit', 'flow-align', 'flow-commit', 'flow-update-skills'].includes(
					w.name
				)
			)
				continue;
			expect(w.body, w.name).toContain('Progress first');
		}
	});

	it('serves flow-align with its rules block and never tells it to claim an item (AFB-20261110-2333)', () => {
		const body = workflowByName('flow-align')!.body;
		expect(body).toContain('five closed classes');
		expect(body).toContain('<!-- afb:flow-align rules ');
		expect(body).toContain('<!-- /afb:flow-align rules -->');
		expect(body).toContain('Do not call work_start and do not call step_done');
		expect(body).not.toContain('Call work_start for the item the user names before any edit');
		expect(SERVER_INSTRUCTIONS).toContain('flow-align');
	});

	it('has the audit report finished work that was never recorded', () => {
		expect(workflowByName('flow-audit')?.body).toContain('NOT RECORDED');
		expect(workflowByName('flow-audit')?.body).toContain('step_done');
	});
});
