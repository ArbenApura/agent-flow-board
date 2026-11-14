// THE INVENTORY SEEDED FROM A MOCKUP'S SOURCE (AFB-20261114-0409, D.6)

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	behaviourPointers,
	motionInClasses,
	motionInCss,
	seedInventory
} from '../../src/lib/server/mockups/inventory';
import { segmentMockupHtml } from '../../src/lib/server/mockups/segments';

// -- CONSTANTS -- //

const PAGE = `<!doctype html><html><head>
<style>
.card{transition:transform .28s cubic-bezier(.2,0,0,1),opacity .18s ease-out}
.toast{animation:drop .3s ease-out}
@keyframes drop{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.card{transition:none}}
</style></head><body>
<section data-ref="screen-today" data-state="default"><h1 data-ref="title">Today</h1>
<div data-ref="card" class="rounded transition duration-300 ease-out">Good morning</div>
<button data-open="t-lab" data-ref="lab-open">Lab request</button>
<button type="button">Call next</button>
<p data-state="empty">A clear day ahead</p></section>
<section data-ref="screen-consult"><h1>Consultation</h1></section>
<template id="t-lab"><div>Lab sheet</div></template>
<script>
document.addEventListener('click', () => {});
el.classList.add('stale');
setTimeout(() => done(), 480);
window.afbSet = function(k, v) {};
</script></body></html>`;

// -- FUNCTIONS -- //

describe('the seeded inventory', () => {
	it('finds the motion in CSS: transitions, animations, keyframes and the reduced-motion rule', () => {
		const lines = motionInCss(
			'.card{transition:transform .28s ease,opacity .18s}.toast{animation:drop .3s ease-out}@keyframes drop{from{opacity:0}}@media (prefers-reduced-motion:reduce){.card{transition:none}}'
		);
		expect(lines).toContain('motion css .card: transition transform .28s ease,opacity .18s');
		expect(lines).toContain('motion css .toast: animation drop .3s ease-out');
		expect(lines).toContain('motion keyframes drop');
		expect(lines).toContain('motion reduced-motion rule present');
	});

	it('finds motion utilities on an element and names the region that holds them', () => {
		expect(
			motionInClasses(
				'<div data-ref="card"><i class="p-2 transition duration-300 ease-out hover:animate-pulse"></i></div>'
			)
		).toEqual(['motion class in card: transition duration-300 ease-out hover:animate-pulse']);
		expect(motionInClasses('<p class="p-2 flex"></p>')).toEqual([]);
	});

	it('points at what the scripts listen to, toggle and time', () => {
		const lines = behaviourPointers(
			"document.addEventListener('click',f);x.classList.add('stale');setTimeout(() => y(), 480);window.afbSet=1;"
		);
		expect(lines).toEqual([
			'behavior listens to: click',
			'behavior toggles classes: stale',
			'behavior timers: 480 ms',
			'behavior answers window.afbSet (the viewer controls)'
		]);
	});

	it('seeds the lines of the screens asked for, with motion and behaviour shared by every screen', () => {
		const cut = segmentMockupHtml(PAGE);
		const inv = seedInventory(PAGE, cut.segments, ['today']);
		expect(inv.scopes).toEqual(['screen:today']);
		const text = inv.lines.join('\n');
		expect(text).toContain('region data-ref=title <h1>');
		expect(text).toContain('text "Good morning"');
		expect(text).toContain('state empty');
		expect(text).toContain('interaction "Lab request" opens surface:lab');
		expect(text).toContain('interaction control "Call next"');
		expect(text).toContain('motion class in card: transition duration-300 ease-out');
		expect(text).toContain(
			'motion css .card: transition transform .28s cubic-bezier(.2,0,0,1),opacity .18s ease-out'
		);
		expect(text).toContain('motion keyframes drop');
		expect(text).toContain('behavior timers: 480 ms');
		// Another screen's text is not on this screen's list
		expect(text).not.toContain('Consultation');
		expect(inv.lines.every((l) => l.startsWith('- [ ] '))).toBe(true);
	});

	it('names a screen it does not have instead of listing nothing', () => {
		const cut = segmentMockupHtml(PAGE);
		expect(seedInventory(PAGE, cut.segments, ['nope', 'surface:lab']).unknown).toEqual([
			'screen:nope'
		]);
		expect(seedInventory(PAGE, cut.segments, ['surface:lab']).lines.join('\n')).toContain(
			'Lab sheet'
		);
	});
});
