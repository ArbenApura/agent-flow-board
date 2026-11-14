// THE REPO CONFIG FILE (afb.runner.json): HOW A PROJECT BUILDS, STARTS AND SIGNS IN. IT LIVES IN THE PROJECT'S OWN REPO (SPEC 10, L1)
// Build and start commands come only from this file in the repo the runner works in, never from the server and never from MCP.
// A local runner asks its owner before it runs a command it has not seen (approvals.ts).

// IMPORTED DEP-MODULES
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// -- TYPES -- //

export type Served = {
	/** Builds the app, when the build is a step of its own. Skipped while the app files are unchanged. */
	build?: string;
	/** Starts the server and keeps running. It may build first itself. */
	start?: string;
	/** The address the started server answers on. */
	url?: string;
	/** A path that answers 200 when the server is ready. Defaults to /. */
	ready?: string;
	/** Use a server that is already answering at the address, instead of starting one. For servers started by hand. */
	reuseRunning?: boolean;
	/** Paths opened once after the start, so the first real page is not the slow one. */
	warm?: string[];
	env?: Record<string, string>;
	cwd?: string;
};
export type RunnerConfig = {
	/** The folders and files whose content decides whether a build is still good. */
	appPaths: string[];
	/**
	 * The person vouches that a server already answering at a target's address runs this working tree. Without it a pass on such a
	 * server is recorded but closes nothing, because nothing proves what code it holds.
	 */
	trustRunning?: boolean;
	preview?: Served;
	dev?: Served;
	signIn: {
		path: string;
		emailLabel: string;
		passwordLabel: string;
		submit: string;
		/** A path the page must leave (the sign-in page) or reach after signing in. */
		successNotPath: string;
	};
	themes: {
		/** localStorage keys set to the theme name before a page loads. */
		storageKeys: string[];
		/** Attributes of the html element set to the theme name. */
		attributes: string[];
	};
	deployed: { waitMinutes: number };
};

// -- CONSTANTS -- //

export const CONFIG_FILE = 'afb.runner.json';
const DEFAULTS: RunnerConfig = {
	appPaths: ['.'],
	signIn: {
		path: '/sign-in',
		emailLabel: 'Email',
		passwordLabel: 'Password',
		submit: 'Sign in',
		successNotPath: '/sign-in'
	},
	themes: {
		storageKeys: ['afb-mode', 'theme', 'color-theme'],
		attributes: ['data-mode', 'data-theme']
	},
	deployed: { waitMinutes: 10 }
};

// -- FUNCTIONS -- //

/** The repo's config with defaults filled in. A missing file is fine: only the targets that need it are then unavailable. */
export function loadConfig(repo: string, explicit?: string): RunnerConfig {
	const file = explicit ? resolve(explicit) : join(repo, CONFIG_FILE);
	if (!existsSync(file)) return DEFAULTS;
	let raw: Partial<RunnerConfig>;
	try {
		raw = JSON.parse(readFileSync(file, 'utf8'));
	} catch (e) {
		throw new Error(`${file} is not valid JSON: ${(e as Error).message}`, { cause: e });
	}
	return {
		...DEFAULTS,
		...raw,
		signIn: { ...DEFAULTS.signIn, ...(raw.signIn ?? {}) },
		themes: { ...DEFAULTS.themes, ...(raw.themes ?? {}) },
		deployed: { ...DEFAULTS.deployed, ...(raw.deployed ?? {}) }
	};
}
