// THE CHECKS TAB: ONE WORD FOR A CHECK, ONE SENTENCE FOR A FAILURE

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	checkStatus,
	closedStep,
	failureSentence,
	resultStatus,
	seconds,
	type CheckRunLite
} from '../../src/lib/shared/checksTab';

// -- CONSTANTS -- //

const run = (extra: Partial<CheckRunLite> = {}): CheckRunLite => ({
	result: 'pass',
	reason: null,
	durationMs: 1200,
	stepKey: null,
	...extra
});

// -- FUNCTIONS -- //

describe('the Checks tab', () => {
	it('names a run in one word, the same words the board uses elsewhere', () => {
		expect(resultStatus('pass')).toEqual({ label: 'Passed', tone: 'success' });
		expect(resultStatus('fail').label).toBe('Failed');
		expect(resultStatus('error').label).toBe('Failed');
		expect(resultStatus('queued')).toEqual({ label: 'Waiting for the runner', tone: 'info' });
		expect(resultStatus('running').tone).toBe('running');
		expect(resultStatus('timeout').label).toBe('Could not run');
		expect(resultStatus('unavailable').label).toBe('Could not run');
		expect(resultStatus('something-new')).toEqual({ label: 'something-new', tone: 'neutral' });
	});

	it('gives a check the status of its newest run, or Open, or Closed when a pass closed it', () => {
		expect(checkStatus('open', [])).toEqual({ label: 'Open', tone: 'neutral' });
		expect(checkStatus('waived', [])).toEqual({ label: 'Closed', tone: 'success' });
		expect(checkStatus('open', [run({ result: 'running' }), run({ result: 'pass' })]).label).toBe(
			'Running'
		);
		expect(checkStatus('open', [run({ result: 'fail' }), run({ result: 'pass' })]).label).toBe(
			'Failed'
		);
	});

	it('says what went wrong in one sentence and what to do, never the raw log', () => {
		expect(failureSentence(run())).toBeNull();
		expect(failureSentence(run({ result: 'running' }))).toBeNull();
		expect(failureSentence(run({ result: 'queued' }))).toBeNull();
		expect(
			failureSentence(
				run({ result: 'fail', reason: 'Save button missing\nstack line 1\nstack line 2' })
			)
		).toBe('Save button missing. Ask your agent to look into it.');
		expect(failureSentence(run({ result: 'error', reason: 'It broke.' }))).toBe(
			'It broke. Ask your agent to look into it.'
		);
		expect(failureSentence(run({ result: 'fail', reason: null }))).toBe(
			'Ask your agent to look into it.'
		);
		expect(failureSentence(run({ result: 'fail', reason: 'x'.repeat(500) }))!.length).toBeLessThan(
			200
		);
		expect(failureSentence(run({ result: 'unavailable' }))).toMatch(/Press Run check again/);
	});

	it('shows how long a run took and the step a pass closed', () => {
		expect(seconds(2400)).toBe('2.4 s');
		expect(seconds(null)).toBe('');
		expect(closedStep(run({ stepKey: '1.2' }))).toBe('Closed step 1.2');
		expect(closedStep(run({ stepKey: null }))).toBe('');
		expect(closedStep(run({ result: 'fail', stepKey: '1.2' }))).toBe('');
	});
});
