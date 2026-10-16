// JOINS CLASS NAMES, DROPPING EMPTY VALUES

// -- TYPES -- //

export type ClassValue = string | false | null | undefined | ClassValue[];

// -- FUNCTIONS -- //

export function cn(...values: ClassValue[]): string {
	return values
		.flat(Infinity as 1)
		.filter((v): v is string => typeof v === 'string' && v.length > 0)
		.join(' ');
}
