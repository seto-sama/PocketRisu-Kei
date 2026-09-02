// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import Checkbox from './Checkbox.svelte';

const mounted: unknown[] = [];

afterEach(async () => {
    await Promise.all(mounted.splice(0).map(component => unmount(component as never)));
    document.body.replaceChildren();
});

describe('Checkbox', () => {
    it('toggles and reports its checked state', async () => {
        let changedTo: boolean | undefined;
        const target = document.createElement('div');
        document.body.appendChild(target);
        mounted.push(mount(Checkbox, {
            target,
            props: {
                check: false,
                card: true,
                hiddenName: true,
                margin: false,
                onChange: (checked) => (changedTo = checked),
            },
        }));
        await tick();

        const button = target.querySelector<HTMLButtonElement>('button')!;
        button.click();
        await tick();

        expect(changedTo).toBe(true);
        expect(button.dataset.state).toBe('checked');
    });
});
