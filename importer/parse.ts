// PURE PARSERS FOR THE HAPR BOARD FILES: PLAN, DECISIONS, LOG, UI CHANGES, TASKS AND THE ID MAP (SPEC 13)
// Nothing here touches a file or a database, so the same code reads the real board, a fixture in a test and the text the
// verification report compares with. A line the parsers cannot place is reported, never dropped without a word.

// -- TYPES -- //

export type StepState = 'open' | 'done' | 'waived' | 'superseded';
export type ParsedStep = { key: string; text: string; state: StepState; notes: string[] };
export type ParsedPhase = { key: string; title: string; steps: ParsedStep[] };
export type ParsedCheck = {
	key: string;
	text: string;
	auto: boolean;
	state: StepState;
	notes: string[];
};
export type ParsedPlan = {
	phases: ParsedPhase[];
	checks: ParsedCheck[];
	/** The checklist lines the grammar did not accept, for the report. */
	unplaced: string[];
};
export type ParsedAdr = {
	number: number;
	title: string;
	context: string;
	decision: string;
	alternatives: string;
	consequences: string;
	/** The block as written, so nothing in an old format is lost. */
	raw: string;
};
export type ParsedSettled = { number: number; question: string; answer: string; source: string };
export type ParsedDecisions = { adrs: ParsedAdr[]; settled: ParsedSettled[]; headings: number };
export type ParsedLog = { at: string | null; text: string; raw: string }[];
export type ParsedUiRow = {
	page: string;
	stateRecipe: string;
	themes: string[];
	accounts: string;
	siblings: string[];
	levels: string[];
	viewports: number[];
};
export type ParsedUiTable = { rows: ParsedUiRow[]; tableRows: number };
export type ParsedTask = {
	number: number;
	title: string;
	group: string;
	status: string;
	priority: string | null;
	task: string;
	links: string;
	notes: string;
	updated: string | null;
	raw: string;
};

// -- CONSTANTS -- //

const STATE_OF: Record<string, StepState> = {
	' ': 'open',
	x: 'done',
	X: 'done',
	'-': 'waived',
	'~': 'superseded'
};
const PHASE = /^##\s+Phase\s+([0-9]+[a-z]?|[A-Z])\s+(.+?)\s*$/;
const STEP = /^- \[([ xX~-])\]\s+([0-9A-Za-z]+\.[0-9]+[a-z]?)\s+(.*)$/;
const CHECK = /^- \[([ xX~-])\]\s+(M[0-9]+)\s+(.*)$/;

// -- FUNCTIONS: PLAN -- //

/** Reads the checklist grammar of PLAN.md. A line that looks like a checklist step but does not fit is listed as unplaced. */
export function parsePlan(text: string): ParsedPlan {
	const out: ParsedPlan = { phases: [], checks: [], unplaced: [] };
	let phase: ParsedPhase | null = null;
	let inChecks = false;
	let last: { notes: string[] } | null = null;
	for (const line of text.split(/\r?\n/)) {
		const p = PHASE.exec(line);
		if (p) {
			phase = { key: p[1], title: p[2], steps: [] };
			out.phases.push(phase);
			inChecks = false;
			last = null;
			continue;
		}
		if (/^##\s+Manual checks/i.test(line)) {
			inChecks = true;
			phase = null;
			last = null;
			continue;
		}
		if (/^##\s/.test(line)) {
			phase = null;
			inChecks = false;
			last = null;
			continue;
		}
		const c = CHECK.exec(line);
		if (c && inChecks) {
			const auto = /\[auto\]/i.test(c[3]);
			const item: ParsedCheck = {
				key: c[2],
				text: c[3].replace(/^\[auto\]\s*/i, '').trim(),
				auto,
				state: STATE_OF[c[1]],
				notes: []
			};
			out.checks.push(item);
			last = item;
			continue;
		}
		const s = STEP.exec(line);
		if (s && phase) {
			const step: ParsedStep = { key: s[2], text: s[3].trim(), state: STATE_OF[s[1]], notes: [] };
			phase.steps.push(step);
			last = step;
			continue;
		}
		if (/^\s{2,}[-*]\s+\S/.test(line) && last) {
			last.notes.push(line.trim().replace(/^[-*]\s+/, ''));
			continue;
		}
		if (/^\s*[-*]\s+\[[ xX~-]\]\s/.test(line)) out.unplaced.push(line.trim());
	}
	return out;
}

// -- FUNCTIONS: DECISIONS -- //

const FIELD_NAMES: Record<string, 'context' | 'decision' | 'alternatives' | 'consequences'> = {
	context: 'context',
	decision: 'decision',
	alternatives: 'alternatives',
	'alternatives considered': 'alternatives',
	consequences: 'consequences',
	'trade-offs': 'consequences',
	tradeoffs: 'consequences',
	status: 'context'
};

/** Splits one ADR block into its fields, in either the bullet style or the sub-heading style. */
function adrFields(body: string) {
	const out = { context: '', decision: '', alternatives: '', consequences: '' };
	const lines = body.split(/\r?\n/);
	let field: keyof typeof out | null = null;
	const buf: Record<string, string[]> = {
		context: [],
		decision: [],
		alternatives: [],
		consequences: []
	};
	const loose: string[] = [];
	for (const line of lines) {
		const bullet = /^\s*[-*]\s+\*\*([^*]+?)\.?\*\*\.?\s*(.*)$/.exec(line);
		const sub = /^#{3,6}\s+(.+?)\s*:?\s*$/.exec(line);
		const name = (bullet?.[1] ?? sub?.[1] ?? '').trim().toLowerCase().replace(/\.$/, '');
		const mapped = FIELD_NAMES[name];
		if (mapped) {
			field = mapped;
			if (bullet?.[2]) buf[field].push(bullet[2]);
			continue;
		}
		if (field) buf[field].push(line);
		else if (line.trim()) loose.push(line);
	}
	for (const k of Object.keys(out) as (keyof typeof out)[]) out[k] = buf[k].join('\n').trim();
	// Text before the first field belongs to the decision when it has none of its own
	if (loose.length)
		out.decision = [loose.join('\n').trim(), out.decision].filter(Boolean).join('\n\n');
	return out;
}

/** The "Settled without asking" table: question, answer and source, one row each. */
function settledRows(block: string): ParsedSettled[] {
	const rows: ParsedSettled[] = [];
	let n = 0;
	for (const line of block.split(/\r?\n/)) {
		if (!line.startsWith('|')) continue;
		const cells = line
			.trim()
			.replace(/^\||\|$/g, '')
			.split(/(?<!\\)\|/)
			.map((c) => c.trim().replace(/\\\|/g, '|'));
		if (cells.length < 3 || /^-+$/.test(cells[0].replace(/\s|:/g, ''))) continue;
		if (/^question$/i.test(cells[0])) continue;
		rows.push({
			number: ++n,
			question: cells[0],
			answer: cells[1],
			source: cells.slice(2).join(' | ')
		});
	}
	return rows;
}

/** ADR blocks and the "Settled without asking" table of DECISIONS.md. */
export function parseDecisions(text: string): ParsedDecisions {
	const lines = text.split(/\r?\n/);
	const adrs: ParsedAdr[] = [];
	const settled: ParsedSettled[] = [];
	let headings = 0;
	type Block = {
		kind: 'adr' | 'settled' | 'other';
		number: number;
		title: string;
		lines: string[];
	};
	const blocks: Block[] = [];
	let cur: Block | null = null;
	for (const line of lines) {
		const adr = /^(#{2,4})\s+ADR[-\s]?(\d+)\s*[:.\-–—]?\s*(.*?)\s*$/i.exec(line);
		const settledHead = /^#{2,4}\s+Settled without asking/i.exec(line);
		const topHead = /^#{1,2}\s+\S/.test(line) && !adr;
		if (adr) {
			headings++;
			cur = { kind: 'adr', number: Number(adr[2]), title: adr[3], lines: [] };
			blocks.push(cur);
		} else if (settledHead) {
			cur = { kind: 'settled', number: 0, title: 'Settled without asking', lines: [] };
			blocks.push(cur);
		} else if (topHead && cur && cur.kind === 'adr') {
			cur = { kind: 'other', number: 0, title: line, lines: [] };
			blocks.push(cur);
		} else if (cur) cur.lines.push(line);
	}
	for (const b of blocks) {
		if (b.kind === 'adr') {
			const body = b.lines.join('\n');
			adrs.push({ number: b.number, title: b.title, ...adrFields(body), raw: body.trim() });
		} else if (b.kind === 'settled') settled.push(...settledRows(b.lines.join('\n')));
	}
	return { adrs, settled, headings };
}

// -- FUNCTIONS: LOG -- //

/** The dated lines of LOG.md. A line without a date keeps its text and has no time. */
export function parseLog(text: string): ParsedLog {
	const out: ParsedLog = [];
	for (const raw of text.split(/\r?\n/)) {
		const m = /^-\s+(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?[,:]?\s*(.*)$/.exec(raw);
		if (!m) continue;
		const at = m[2] ? `${m[1]}T${m[2]}:00+08:00` : `${m[1]}T00:00:00+08:00`;
		out.push({ at, text: m[3].trim(), raw: raw.trim() });
	}
	return out;
}

// -- FUNCTIONS: UI CHANGES -- //

const ticks = (s: string) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const cells = (line: string) =>
	line
		.trim()
		.replace(/^\||\|$/g, '')
		.split('|')
		.map((c) => c.trim());

/**
 * The "UI changes" table of VALIDATION.md. HAPR names the themes column Brands or Themes. A cell with several pages becomes
 * one row for each page, and a cell with several states one row for each state.
 */
export function parseUiChanges(text: string, allThemes: string[]): ParsedUiTable {
	const lines = text.split(/\r?\n/);
	const head = lines.findIndex(
		(l) => l.startsWith('|') && /\bPage\b/.test(l) && /\bSiblings\b/.test(l) && /\bLevels\b/.test(l)
	);
	if (head < 0) return { rows: [], tableRows: 0 };
	const names = cells(lines[head]).map((n) => n.toLowerCase());
	const col = (...ns: string[]) => names.findIndex((n) => ns.includes(n));
	const iPage = col('page');
	const iState = col('state');
	const iThemes = col('themes', 'brands');
	const iAccounts = col('accounts', 'account');
	const iSib = col('siblings');
	const iLevels = col('levels');
	const iView = col('viewports');
	const rows: ParsedUiRow[] = [];
	let tableRows = 0;
	for (let i = head + 2; i < lines.length && lines[i].startsWith('|'); i++) {
		const c = cells(lines[i]);
		if (c.length < names.length) continue;
		tableRows++;
		const pages = ticks(c[iPage]);
		const states = (iState >= 0 ? c[iState] : 'none')
			.split(/,(?=(?:[^`]*`[^`]*`)*[^`]*$)/)
			.map((s) => s.trim())
			.filter(Boolean)
			.map((s) => (s === 'none' ? '' : s.replace(/`/g, '').trim()));
		const themeCell = iThemes >= 0 ? c[iThemes].trim() : 'both';
		const themes = themeCell === 'both' ? allThemes : themeCell.split(/,\s*/).filter(Boolean);
		for (const page of pages.length ? pages : [c[iPage].trim()])
			for (const stateRecipe of states.length ? states : [''])
				rows.push({
					page,
					stateRecipe,
					themes,
					accounts:
						(iAccounts >= 0 ? c[iAccounts] : 'default').replace(/`/g, '').trim() || 'default',
					siblings: iSib >= 0 ? ticks(c[iSib]) : [],
					levels:
						iLevels >= 0
							? c[iLevels]
									.split(',')
									.map((l) => l.trim())
									.filter(Boolean)
							: [],
					viewports:
						iView >= 0
							? c[iView]
									.split(',')
									.map((v) => Number(v.trim()))
									.filter((n) => n > 0)
							: []
				});
	}
	return { rows, tableRows };
}

// -- FUNCTIONS: TASKS AND IDS -- //

/** The tasks of TASKS.md: a `### T-nn Title` heading, then bullets. The heading above a task is its group. */
export function parseTasks(text: string): ParsedTask[] {
	const out: ParsedTask[] = [];
	let group = '';
	const blocks = text.split(/\r?\n(?=##{1,2} )/);
	for (const block of blocks) {
		const g = /^##\s+(?!#)(.+)$/m.exec(block.split('\n')[0] ?? '');
		if (g && !/^###/.test(block)) group = g[1].trim();
		const t = /^###\s+T-(\d+)\s+(.*)$/m.exec(block);
		if (!t) continue;
		const field = (name: string) => {
			const m = new RegExp(`^- \\*\\*${name}:\\*\\*\\s*(.*)$`, 'mi').exec(block);
			return m ? m[1].trim() : '';
		};
		out.push({
			number: Number(t[1]),
			title: t[2].trim(),
			group,
			status: field('Status').replace(/`/g, '') || 'TODO',
			priority: field('Priority').replace(/`/g, '') || null,
			task: field('Task'),
			links: field('Links'),
			notes: field('Notes'),
			updated: field('Updated') || null,
			raw: block.trim()
		});
	}
	return out;
}

/** The legacy number to FLOW id rows of ID-MAP.md, with the folder name that follows. */
export function parseIdMap(text: string): { legacy: string; flow: string; name: string }[] {
	const rows: { legacy: string; flow: string; name: string }[] = [];
	for (const line of text.split(/\r?\n/)) {
		const m =
			/^\|\s*`(FEAT-\d+)`\s*\|\s*`(FLOW-[0-9-a-z]+)`\s*\|[^|]*\|\s*`?([^`|]*?)`?\s*\|?\s*$/.exec(
				line
			);
		if (m) rows.push({ legacy: m[1], flow: m[2], name: m[3].trim() });
	}
	return rows;
}
