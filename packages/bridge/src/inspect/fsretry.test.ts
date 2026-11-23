// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { renameRetry, withRetry } from './fsretry.js';

const busy = (code: string) => Object.assign(new Error(code), { code });

describe('fsretry', () => {
	it('tries a busy file again and then succeeds', () => {
		let n = 0;
		renameRetry('a', 'b', () => {
			if (++n < 3) throw busy(n === 1 ? 'EPERM' : 'EBUSY');
		});
		expect(n).toBe(3);
	});
	it('retries EACCES too', () => {
		let n = 0;
		expect(
			withRetry(() =>
				++n < 2
					? (() => {
							throw busy('EACCES');
						})()
					: 'ok'
			)
		).toBe('ok');
	});
	it('throws any other error at once', () => {
		let n = 0;
		expect(() =>
			withRetry(() => {
				n++;
				throw busy('ENOENT');
			})
		).toThrow('ENOENT');
		expect(n).toBe(1);
	});
	it('gives up after the waits are used', () => {
		let n = 0;
		expect(() =>
			withRetry(() => {
				n++;
				throw busy('EPERM');
			}, [1, 1])
		).toThrow('EPERM');
		expect(n).toBe(3);
	});
});
