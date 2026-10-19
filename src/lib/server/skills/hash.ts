// THE CONTENT HASH OF A SKILL: SHA-256 OVER ITS NAME, ITS SUMMARY, THE BODY AS IT IS SERVED ONCE WRAPPED AND ITS SUPPORTING FILES
// The board stores it on the row and on every revision, and the bridge will compare it with the file it wrote, so a change
// anywhere in the served text shows up as a different hash.

// -- TYPES -- //
import type { SkillSupportFile } from '../../shared/skills';
// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
// -- MODULES -- //
import { skillHashText } from '../../shared/skills';

// -- TYPES -- //

export type SkillText = { name: string; summary: string; body: string };

// -- FUNCTIONS -- //

/**
 * The hash of one skill as it is served. Two line breaks keep the parts apart, so moving a word from the summary into the
 * body cannot leave the hash the same. A skill without files hashes as it always did (see skillHashText).
 */
export function skillHash(skill: SkillText, files: SkillSupportFile[] = []): string {
	return createHash('sha256').update(skillHashText(skill, files)).digest('hex');
}
