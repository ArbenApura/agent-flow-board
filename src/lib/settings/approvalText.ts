// THE PLAIN SENTENCES OF THE "WHAT YOUR AGENT DID ON ITS OWN" LIST. Built from the structured action and the server-normalised target, never from the agent's own words.

// -- CONSTANTS -- //

/** The sentence around the target of each action (the target is shown verbatim, in the mono face, after `before`). */
const SENTENCES: Record<string, { before: string; after: string }> = {
	register: { before: 'Added the live site ', after: '' },
	secrets: { before: 'Stored the test keys for ', after: '' },
	'adopt-env': { before: 'Used the env settings of ', after: '' },
	roots: { before: 'Added the folder ', after: '' },
	pictures: { before: 'Kept pictures of signed-in pages for ', after: '' },
	login: { before: 'Opened a sign-in window for ', after: '' }
};

// -- FUNCTIONS -- //

export function approvalSentence(action: string): { before: string; after: string } {
	return SENTENCES[action] ?? { before: 'Did something with ', after: '' };
}

/** The small badge after a row: done when the machine used it, ready while it still can, otherwise not used. */
export function approvalState(status: string): {
	tone: 'success' | 'warning' | 'neutral';
	label: string;
} {
	if (status === 'claimed') return { tone: 'success', label: 'Done' };
	if (status === 'approved') return { tone: 'warning', label: 'Ready' };
	return { tone: 'neutral', label: 'Not used' };
}
