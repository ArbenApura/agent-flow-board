// PLAN RULES A PROJECT WRITES IN ITS RULES TEXT, CHECKED WHEN AN AGENT WRITES A PLAN (item_new, plan_add_phase, plan_add_steps, step_update)
// A repo has rules about what a plan may contain (no browser steps, no mockups, no demo hosts, no database reset). They used to live
// in prose that a model had to remember. Two line forms in the project rules text turn them into a refusal with the reason:
//   forbid-plan: <phrase>|<phrase> :: <reason>        a step, check or title containing any phrase is refused (case insensitive)
//   no-browser-steps                                   a step with a required target or an automatic check is refused

// -- TYPES -- //
import type { Tx } from '../db/client';
// -- DEP-MODULES -- //
import { eq } from 'drizzle-orm';
// -- MODULES -- //
import { project } from '../db/schema';
import { OpError } from './context';

// -- TYPES -- //

export type PlanRules = {
	forbid: { pattern: RegExp; reason: string }[];
	noBrowserSteps: boolean;
};
export type PlanText = {
	/** Titles, step texts and check texts to test against the forbid lines. */
	texts: string[];
	/** Whether any step carries a required target or any manual check is automatic. */
	browser: boolean;
};

// -- CONSTANTS -- //

const FORBID_LINE = /^\s*forbid-plan:\s*(.+?)\s*(?:::\s*(.*?))?\s*$/i;
const NO_BROWSER_LINE = /^\s*no-browser-steps\s*$/i;
const MAX_PATTERN = 200;
// A pattern written by an admin is only ever run on this much of one text, so a bad expression cannot stall a write
const MAX_TEXT = 2000;

// -- FUNCTIONS -- //

/** Reads the plan rules out of a project's rules text. A line that is not a valid rule is skipped, never an error. */
export function parsePlanRules(rulesText: string): PlanRules {
	const rules: PlanRules = { forbid: [], noBrowserSteps: false };
	for (const line of rulesText.split(/\r?\n/)) {
		if (NO_BROWSER_LINE.test(line)) {
			rules.noBrowserSteps = true;
			continue;
		}
		const m = FORBID_LINE.exec(line);
		if (!m || m[1].length > MAX_PATTERN) continue;
		// Phrases, not regular expressions: a pattern an admin writes runs on every plan write inside the one server process, and an
		// expression with nested repeats can stall it. Escaped phrases joined by | match in linear time.
		const phrases = m[1]
			.split('|')
			.map((p) => p.trim())
			.filter(Boolean)
			.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
		if (!phrases.length) continue;
		rules.forbid.push({
			pattern: new RegExp(phrases.join('|'), 'i'),
			reason: m[2]?.trim() || `plans may not mention ${m[1]}`
		});
	}
	return rules;
}

/** The reasons a piece of plan text breaks the rules, one per rule. Empty when it is fine. */
export function planViolations(rules: PlanRules, plan: PlanText): string[] {
	const out: string[] = [];
	for (const f of rules.forbid)
		if (plan.texts.some((t) => f.pattern.test(t.slice(0, MAX_TEXT)))) out.push(f.reason);
	if (rules.noBrowserSteps && plan.browser)
		out.push(
			'this project keeps browser steps out of plans (no required target on a step, no automatic check)'
		);
	return out;
}

/** The plan rules of one project. */
export async function projectPlanRules(tx: Tx, projectId: string): Promise<PlanRules> {
	const [row] = await tx
		.select({ rules: project.rules })
		.from(project)
		.where(eq(project.id, projectId));
	return parsePlanRules(row?.rules ?? '');
}

/** Refuses a plan that breaks the project's plan rules, naming each reason. */
export async function enforcePlanRules(tx: Tx, projectId: string, plan: PlanText): Promise<void> {
	const rules = await projectPlanRules(tx, projectId);
	const reasons = planViolations(rules, plan);
	if (reasons.length)
		throw new OpError(
			'INVALID',
			`This project's plan rules refuse that text: ${reasons.join('; ')}. Reword it, or ask an admin to change the plan rules in the project rules.`,
			{ planRules: reasons }
		);
}
