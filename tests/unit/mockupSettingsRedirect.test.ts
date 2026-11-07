// THE OLD MOCKUP SETTINGS ADDRESS (AFB-20261107-1337): THE PAGE IS GONE, SO A BOOKMARK GOES TO THE MOCKUPS PAGE

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import { GET } from '../../src/routes/[org]/[project]/mockups/settings/+server';

// -- FUNCTIONS -- //

describe('the old mockup settings address', () => {
	const run = (org: string, project: string) => {
		try {
			(GET as (e: unknown) => unknown)({ params: { org, project } });
		} catch (e) {
			return e as { status: number; location: string };
		}
		return null;
	};

	it('redirects for good to the Mockups page of the same project', () => {
		expect(run('arbenger', 'AFB')).toMatchObject({
			status: 308,
			location: '/arbenger/AFB/mockups'
		});
	});

	it('builds the target from the two names only, so it can never leave the site', () => {
		const r = run('//evil.example', '..%2f');
		expect(r?.location.startsWith('/')).toBe(true);
		expect(r?.location.startsWith('//')).toBe(false);
		expect(r?.location).toBe('/%2F%2Fevil.example/..%252f/mockups');
	});
});
