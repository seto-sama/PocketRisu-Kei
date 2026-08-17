import { mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import AudioPlayer from './AudioPlayer.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

describe('AudioPlayer', () => {
    beforeEach(() => {
        vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
        vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
        vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    });

    afterEach(async () => {
        await Promise.all(mountedComponents.splice(0).map((component) => unmount(component)));
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    test('renders themed controls with the asset and character names', () => {
        const target = document.createElement('div');
        document.body.appendChild(target);
        mountedComponents.push(mount(AudioPlayer, {
            target,
            props: {
                src: 'blob:test-audio',
                title: 'Night Walk',
                characterName: 'Airisu',
                autoplay: false,
            },
        }));

        expect(target.textContent).toContain('Night Walk');
        expect(target.textContent).toContain('Airisu');
        expect(target.querySelector('[aria-label="Play"]')).not.toBeNull();
        expect(target.querySelectorAll('input[type="range"]')).toHaveLength(2);
    });
});
