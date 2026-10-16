// WHEN A DELETED ORGANISATION IS ERASED, AND HOW A TYPED NAME IS COMPARED (FLOW-20261017-0007, ADR-004 AND ADR-016)
// Shared by the server and the confirmation dialog, so both read the same days and the same rule.

// -- CONSTANTS -- //

/** Days a deleted org stays recoverable. Proposed value: one constant, not a setting, until it is confirmed. */
export const ORG_DELETE_GRACE_DAYS = 7;

// -- FUNCTIONS -- //

/** The moment a deleted org is erased. The locked page and the purge both read it from here, so they never disagree. */
export function purgeAt(deletedAt: Date): Date {
	return new Date(deletedAt.getTime() + ORG_DELETE_GRACE_DAYS * 24 * 60 * 60 * 1000);
}

/** The typed name must match the org name exactly: surrounding spaces and Unicode form are ignored, letter case is not. */
export function sameOrgName(typed: string, name: string): boolean {
	return typed.normalize('NFC').trim() === name.normalize('NFC').trim();
}
