// PASSWORD STRENGTH HINT: LENGTH FIRST, THEN VARIETY. IT ONLY ADVISES. THE SERVER STILL ENFORCES THE MINIMUM LENGTH

// -- TYPES -- //

export type Strength = {
	/** 0 to 4 filled parts of the meter. */
	score: 0 | 1 | 2 | 3 | 4;
	tone: 'danger' | 'warning' | 'success';
	label: string;
};

// -- FUNCTIONS -- //

export function strengthOf(password: string, min = 10): Strength {
	if (password.length < min) {
		const left = min - password.length;
		return {
			score: 1,
			tone: 'danger',
			label: `${left} more ${left === 1 ? 'character' : 'characters'} to go.`
		};
	}
	const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
	const words = password.trim().split(/\s+/).length;
	// A long sentence is as good as symbols, so length and word count count as well as variety
	const points = kinds + (password.length >= 16 ? 1 : 0) + (words >= 3 ? 1 : 0);
	if (points >= 5) return { score: 4, tone: 'success', label: 'Strong. This is hard to guess.' };
	if (points >= 3) return { score: 3, tone: 'success', label: 'Good. This will do.' };
	return {
		score: 2,
		tone: 'warning',
		label: 'Long enough. Adding a few words or a number makes it stronger.'
	};
}
