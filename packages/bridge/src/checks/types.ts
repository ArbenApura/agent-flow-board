// THE SHARED SHAPES OF THE CHECK COMMANDS. EVERY MODULE IN THIS FOLDER IMPORTS FROM HERE, SO THE PARTS FIT.

// -- TYPES -- //

/** What a run needs to know about the repo it builds and previews. Built by recipe.ts from `.afb-checks.json` or plain detection. */
export type ProjectConfig = {
	/** The real path of the repo folder (the folder the agent is in). */
	repo: string;
	/** `yarn build` or the like. Absent when the app needs no build. Already checked by commandProblem. */
	build?: string;
	/** The start command with a `{port}` placeholder, for example `yarn preview --port {port}`. Already checked by commandProblem. */
	start: string;
	/** The path to poll until the preview answers, default `/`. */
	ready?: string;
	/** True when the app needs a database: the tool makes a throwaway one (Docker) and passes it in. */
	needsDatabase: boolean;
	/** The runtime role the app connects as, when the recipe names one. */
	runtimeRole?: string;
	/** A preview-only account the recipe asks the tool to sign in with. */
	testUser?: { email: string; password: string };
	/** Settings from the recipe: placeholders already allowed by recipe.ts, resolved by the preview. */
	env: Record<string, string>;
	/** Folders and files that say what was tested (hashed into the run's evidence). */
	appPaths: string[];
};

/** A resource a run owns, closed newest first when the run ends, whatever ends it. */
export type Disposer = () => void | Promise<void>;

/** The things one run owns. Created by scope.ts; the run id names every resource, a marker file proves the run is live. */
export interface RunScopeLike {
	readonly runId: string;
	/** Registers a resource under a name. It is closed when the scope closes. */
	add(name: string, dispose: Disposer): void;
	/** Closes every resource, newest first, and removes the live marker. Never throws; a failure is logged by the caller's log. */
	close(): Promise<void>;
}

/** What startPreview hands back. */
export type Preview = {
	/** http://127.0.0.1:<port> of the running preview. */
	baseUrl: string;
	/** The commit the private copy was made from, or null when the repo has no commit. */
	commit: string | null;
	/** A hash of the files that decide what ran, plus uncommitted changes, so the board shows what was tested. */
	diffHash: string | null;
	/** The preview-only account to sign in as, when the recipe has one. */
	testUser: { email: string; password: string } | null;
	/** Exact strings that must never be printed or uploaded (passwords made for this run). */
	secrets: string[];
	/** One plain line for the run log, for example that a throwaway database was made. */
	note?: string;
};

/** The job handed to the sandboxed child that runs one check script. Written to the child's stdin. */
export type ChildJob = {
	baseUrl: string;
	/** The Playwright browser server the parent started; the child only connects to it. */
	ws: string;
	/** The saved browser state for a signed in run, or null. */
	storageState: unknown;
	/** The absolute path of the check script inside the scripts folder. */
	checkFile: string;
	/** The run folder: the only place the child may write. */
	runDir: string;
	viewport: { width: number; height: number };
	extraHosts: string[];
	/** Exact strings to remove from everything the child prints or saves. */
	needles: string[];
};

/** What the child writes to result.json. */
export type ChildResult = {
	schema: 1;
	result: 'pass' | 'fail';
	reason: string | null;
	durationMs: number;
	steps: {
		name: string;
		status: 'pass' | 'fail' | 'shot';
		ms: number;
		shot: string | null;
		error?: string;
	}[];
	log: string;
	blockedWrites: number;
	blockedOutside: number;
};
