<script lang="ts">
    interface Props {
        rise?: string;
    }

    interface SelectionParticle {
        id: number;
        x: string;
        size: string;
        duration: string;
    }

    let { rise = '-6rem' }: Props = $props();
    let particles = $state<SelectionParticle[]>([]);
    let nextParticleId = 0;
    const particleMap = new Map<number, SelectionParticle>();

    function randomBetween(min: number, max: number) {
        return min + Math.random() * (max - min);
    }

    $effect(() => {
        particleMap.clear();
        particles = [];
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

        let spawnTimer: ReturnType<typeof setTimeout> | undefined;
        const removalTimers = new Set<ReturnType<typeof setTimeout>>();

        const spawnParticle = () => {
            const durationSeconds = randomBetween(1.75, 2.45);
            const particle: SelectionParticle = {
                id: nextParticleId++,
                x: `${randomBetween(7, 93).toFixed(1)}%`,
                size: `${randomBetween(1, 2.5).toFixed(2)}px`,
                duration: `${durationSeconds.toFixed(2)}s`,
            };

            particleMap.set(particle.id, particle);
            particles = [...particleMap.values()];

            const removalTimer = setTimeout(() => {
                particleMap.delete(particle.id);
                removalTimers.delete(removalTimer);
                particles = [...particleMap.values()];
            }, durationSeconds * 1000 + 100);
            removalTimers.add(removalTimer);

            spawnTimer = setTimeout(spawnParticle, randomBetween(180, 420));
        };

        spawnParticle();

        return () => {
            if (spawnTimer) clearTimeout(spawnTimer);
            removalTimers.forEach(clearTimeout);
            particleMap.clear();
            particles = [];
        };
    });
</script>

<span class="avatar-selection-glow" aria-hidden="true"></span>
<span
    class="avatar-selection-particles"
    style={`--particle-rise: ${rise}`}
    aria-hidden="true"
>
    {#each particles as particle (particle.id)}
        <span
            class="avatar-selection-particle"
            style={`--x: ${particle.x}; --size: ${particle.size}; --duration: ${particle.duration};`}
        ></span>
    {/each}
</span>

<style>
    .avatar-selection-glow {
        position: absolute;
        inset: 0;
        z-index: 1;
        border-radius: inherit;
        background: linear-gradient(
            to top,
            color-mix(in srgb, var(--risu-theme-primary) 53%, transparent) 0%,
            color-mix(in srgb, var(--risu-theme-primary) 28%, transparent) 20%,
            color-mix(in srgb, var(--risu-theme-primary) 13%, transparent) 42%,
            transparent 75%
        );
        pointer-events: none;
    }

    .avatar-selection-particles {
        position: absolute;
        inset: 2px;
        z-index: 3;
        overflow: hidden;
        border-radius: inherit;
        mix-blend-mode: plus-lighter;
        pointer-events: none;
    }

    .avatar-selection-particle {
        position: absolute;
        bottom: 1px;
        left: var(--x);
        width: var(--size);
        height: var(--size);
        border-radius: 9999px;
        background: color-mix(in srgb, var(--risu-theme-primary) 72%, white);
        box-shadow:
            0 0 2px color-mix(in srgb, var(--risu-theme-primary) 85%, white),
            0 0 5px var(--risu-theme-primary);
        opacity: 0;
        animation: avatar-particle-rise var(--duration) cubic-bezier(0, 0, 0.45, 1) forwards;
        will-change: transform, opacity;
    }

    @keyframes avatar-particle-rise {
        0% {
            opacity: 0;
            transform: translate3d(0, 3px, 0) scale(0.65);
        }
        14% {
            opacity: 0.9;
        }
        45% {
            opacity: 0.76;
        }
        70% {
            opacity: 0.46;
        }
        88% {
            opacity: 0.16;
        }
        100% {
            opacity: 0;
            transform: translate3d(0, var(--particle-rise), 0) scale(0.35);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .avatar-selection-particles {
            display: none;
        }
    }
</style>
