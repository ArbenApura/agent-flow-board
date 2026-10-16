// WHICH FILE PATHS COUNT AS CODE FOR THE "CODE CHANGED, NOTHING RECORDED" REMINDER (SPEC 9.3)
// Plans, docs, notes and tool folders are not code, so editing them never asks anyone to record progress.

// -- CONSTANTS -- //

const CODE_EXT =
	/\.(?:ts|tsx|js|jsx|mjs|cjs|svelte|vue|astro|py|rb|go|rs|java|kt|cs|php|swift|c|h|cc|cpp|hpp|css|scss|less|html|sql|sh|ps1|bat|lua|dart|ex|exs)$/i;
const NOT_CODE_DIR =
	/(?:^|\/)(?:\.git|\.board|\.claude|\.agents|\.gemini|\.vscode|\.idea|node_modules|dist|build|\.svelte-kit|coverage|docs?|\.afb)(?:\/|$)/i;

// -- FUNCTIONS -- //

/** True for a source file outside the folders that hold plans, docs, tools and build output. */
export function isCodeFile(path: string): boolean {
	const p = path.replace(/\\/g, '/');
	return CODE_EXT.test(p) && !NOT_CODE_DIR.test(p);
}

/** True when a shell command makes a commit, which is code change enough even when no edit tool was seen. */
export const commits = (command: string): boolean =>
	/(?:^|[;&|(]\s*|\s)git(?:\.exe)?\s+(?:-C\s+\S+\s+)?commit\b/.test(command) &&
	!/--dry-run/.test(command);
