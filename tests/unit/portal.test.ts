// THE PORTAL TARGET: MENUS, MODALS AND TOASTS GO INTO THE ELEMENT IN FULL SCREEN, OTHERWISE INTO THE BODY

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { portalTarget } from '../../src/lib/actions/portal';

// -- CONSTANTS -- //

// The test runs without a browser, so plain objects stand in for elements
const body = { appendChild: () => null } as unknown as HTMLElement;
const root = { appendChild: () => null } as unknown as HTMLElement;

// -- FUNCTIONS -- //

describe('portalTarget', () => {
	it('is the body when nothing is in full screen', () => {
		expect(portalTarget(null, body)).toBe(body);
		expect(portalTarget(undefined, body)).toBe(body);
	});
	it('is the element in full screen, because only its subtree is drawn then', () => {
		expect(portalTarget(root, body)).toBe(root);
	});
	it('stays on the body when the whole page is in full screen', () => {
		expect(portalTarget(body, body)).toBe(body);
	});
});
