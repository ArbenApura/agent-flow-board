// THE NAMES A PUBLISH TARGET MAY USE, SHARED BY THE SERVER SCHEMA AND THE CONNECT FORM SO BOTH REFUSE THE SAME THINGS

// -- CONSTANTS -- //

export const DEFAULT_PUBLISH_BRANCH = 'board-publish';
export const DEFAULT_PUBLISH_FOLDER = 'board';
export const BRANCH_CHARACTERS = /^[A-Za-z0-9._/-]{1,100}$/;
export const FOLDER_CHARACTERS = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

// -- FUNCTIONS -- //

/** The rules of git check-ref-format that a name built from letters, digits, dots, dashes and slashes can still break. */
export function isGitBranchName(name: string): boolean {
	if (name.startsWith('/') || name.endsWith('/') || name.includes('//') || name.includes('..'))
		return false;
	if (name.startsWith('-') || name.endsWith('.') || name === '@') return false;
	return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}

/** A folder never climbs: a `..` part would reach outside the folder the publish owns. */
export function isPublishFolder(path: string): boolean {
	return path.split('/').every((part) => part !== '.' && part !== '..');
}

/** The plain sentence for a branch name that cannot be used, or an empty string when it can. */
export function branchProblem(name: string): string {
	if (!BRANCH_CHARACTERS.test(name)) return 'Use letters, digits, dots, dashes and slashes.';
	if (!isGitBranchName(name)) return 'Git does not accept that as a branch name.';
	return '';
}

/** The plain sentence for a folder name that cannot be used, or an empty string when it can. */
export function folderProblem(path: string): string {
	if (!FOLDER_CHARACTERS.test(path) || !isPublishFolder(path))
		return 'Use letters, digits, dots, dashes and slashes, and no ".." part.';
	return '';
}
