// THE CONTENT HASH OF A SKILL: SHA-256 OVER ITS NAME, ITS SUMMARY AND THE BODY AS IT IS SERVED ONCE WRAPPED
// The board stores it on the row and on every revision, and the bridge will compare it with the file it wrote, so a change
// anywhere in the served text shows up as a different hash.

// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';

// -- TYPES -- //

export type SkillText = { name: string; summary: string; body: string };

// -- FUNCTIONS -- //

/**
 * The hash of one skill as it is served. Two line breaks keep the parts apart, so moving a word from the summary into the
 * body cannot leave the hash the same.
 */
export function skillHash({ name, summary, body }: SkillText): string {
	return createHash('sha256').update(`${name}\n\n${summary}\n\n${body}`).digest('hex');
}
