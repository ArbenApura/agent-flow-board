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
	/** The app folder inside the repo (`web`): install, build and start run in it, the private copy is made from the git root. */
	appDir?: string;
	/** The registration this config came from. Sign-ins, sealed secrets and caches are looked up under it and never under another. */
	registration?: { org: string; name: string };
	/** True when the owner approved adopting the whole repo .env for this registration. */
	adoptEnv?: boolean;
	/** A live site: nothing is built or started, the run is unverified. */
	url?: string;
	/** Exact host names the browser may reach besides the preview. */
	extraHosts?: string[];
};

/** One registration, saved as registrations/<org>/<NAME>.json (the name is the bare NAME the board knows, 1 to 32 letters, digits, dash, underscore). */
export type Registration = {
	org: string;
	name: string;
	/** The board project key this registration serves. Defaults to the name. */
	boardProject: string;
	/** The repo folder (a real path), absent for a live site. */
	repo?: string;
	appDir?: string;
	recipe: boolean;
	database: 'none' | 'tool';
	/** A live site (http or https), no repo. */
	url?: string;
	extraHosts?: string[];
	/** Whole-.env adoption approved by the owner with a code. Off by default. */
	adoptEnv: boolean;
	/** Pictures of a signed-in run are uploaded only when the owner opted in. */
	uploadSignedInPictures: boolean;
	/** The pinned hash of the files that decide what runs (set by the first `check run` in the folder). */
	pin?: string;
	createdAt: string;
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
	/** Hosts the browser may reach besides the preview (the sealed test project's host, a live site's hosts). */
	extraHosts?: string[];
	/** Set when the mail guard fenced this run: the one test inbox, the guard's log and the preview port. */
	mail?: { inbox: string; log: string; port: number };
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
