// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { isEventFromInteractiveChild } from './utils';

describe('isEventFromInteractiveChild', () => {
	it('distinguishes nested controls from ordinary row content', () => {
		const row = document.createElement('div');
		const text = document.createElement('span');
		const checkbox = document.createElement('button');
		const results: boolean[] = [];

		row.append(text, checkbox);
		row.addEventListener('click', (event) => results.push(isEventFromInteractiveChild(event)));

		text.click();
		checkbox.click();
		row.click();

		expect(results).toEqual([false, true, false]);
	});
});
