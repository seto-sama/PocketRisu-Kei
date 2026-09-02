<script lang="ts">
    import type { Snippet } from 'svelte';
    import type { HTMLAttributes } from 'svelte/elements';

    const DEFAULT_SMOOTHING_MS = 70;
    const MAX_FRAME_GAP_MS = 64;
    const DEFAULT_FRAME_MS = 16;
    const SCROLL_SETTLE_EPSILON_PX = 0.5;
    const EXTERNAL_SCROLL_THRESHOLD_PX = 1;
    const LINE_DELTA_PIXELS = 16;

    type Props = HTMLAttributes<HTMLDivElement> & {
        enabled?: boolean;
        multiplier?: number;
        smoothingMs?: number;
        className?: string;
        element?: HTMLDivElement;
        children?: Snippet;
    };

    let {
        enabled = true,
        multiplier = 1,
        smoothingMs = DEFAULT_SMOOTHING_MS,
        className = '',
        element = $bindable(),
        children,
        ...rest
    }: Props = $props();

    function horizontalWheel(node: HTMLDivElement, initiallyEnabled: boolean) {
        let wheelEnabled = initiallyEnabled;
        let animationFrame: number | null = null;
        let targetScrollLeft = node.scrollLeft;
        let previousTimestamp: number | null = null;
        let lastAnimatedScrollLeft: number | null = null;
        const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

        function stopAnimation() {
            if (animationFrame !== null) cancelAnimationFrame(animationFrame);
            animationFrame = null;
            previousTimestamp = null;
            targetScrollLeft = node.scrollLeft;
            lastAnimatedScrollLeft = null;
        }

        function animate(timestamp: number) {
            const maxScrollLeft = Math.max(0, node.scrollWidth - node.clientWidth);
            targetScrollLeft = Math.max(0, Math.min(maxScrollLeft, targetScrollLeft));
            const elapsed = Math.min(
                MAX_FRAME_GAP_MS,
                previousTimestamp === null ? DEFAULT_FRAME_MS : timestamp - previousTimestamp,
            );
            previousTimestamp = timestamp;
            const distance = targetScrollLeft - node.scrollLeft;
            if (Math.abs(distance) < SCROLL_SETTLE_EPSILON_PX) {
                node.scrollLeft = targetScrollLeft;
                lastAnimatedScrollLeft = node.scrollLeft;
                animationFrame = null;
                previousTimestamp = null;
                return;
            }

            const blend = 1 - Math.exp(-elapsed / Math.max(1, smoothingMs));
            node.scrollLeft += distance * blend;
            lastAnimatedScrollLeft = node.scrollLeft;
            animationFrame = requestAnimationFrame(animate);
        }

        function handleDirectManipulation() {
            stopAnimation();
        }

        function handleScroll() {
            if (animationFrame === null) {
                targetScrollLeft = node.scrollLeft;
                lastAnimatedScrollLeft = null;
                return;
            }

            // A scrollbar drag or another native scroll can move the element
            // while a wheel animation is still targeting an older position.
            if (lastAnimatedScrollLeft !== null
                && Math.abs(node.scrollLeft - lastAnimatedScrollLeft) > EXTERNAL_SCROLL_THRESHOLD_PX) {
                stopAnimation();
            }
        }

        function normalizeDelta(event: WheelEvent) {
            let delta = event.deltaY;
            if (event.deltaMode === 1) delta *= LINE_DELTA_PIXELS;
            else if (event.deltaMode === 2) delta *= node.clientWidth;
            return delta * multiplier;
        }

        function handleWheel(event: WheelEvent) {
            if (!wheelEnabled || node.scrollWidth <= node.clientWidth) return;

            // Keep native trackpad and horizontal-wheel scrolling. Only map a
            // predominantly vertical wheel gesture onto the horizontal axis.
            if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
                stopAnimation();
                return;
            }

            const delta = normalizeDelta(event);
            if (!delta) return;
            const maxScrollLeft = Math.max(0, node.scrollWidth - node.clientWidth);
            const baseTarget = animationFrame === null ? node.scrollLeft : targetScrollLeft;
            const canScroll = delta < 0
                ? baseTarget > 0 || node.scrollLeft > 0
                : baseTarget < maxScrollLeft || node.scrollLeft < maxScrollLeft;
            if (!canScroll) return;

            event.preventDefault();
            targetScrollLeft = Math.max(0, Math.min(maxScrollLeft, baseTarget + delta));
            if (reducedMotionQuery.matches) {
                node.scrollLeft = targetScrollLeft;
                return;
            }
            if (animationFrame === null) animationFrame = requestAnimationFrame(animate);
        }

        node.addEventListener('wheel', handleWheel, { passive: false });
        node.addEventListener('pointerdown', handleDirectManipulation, { passive: true });
        node.addEventListener('scroll', handleScroll, { passive: true });

        return {
            update(nextEnabled: boolean) {
                wheelEnabled = nextEnabled;
                if (!wheelEnabled) stopAnimation();
            },
            destroy() {
                stopAnimation();
                node.removeEventListener('wheel', handleWheel);
                node.removeEventListener('pointerdown', handleDirectManipulation);
                node.removeEventListener('scroll', handleScroll);
            },
        };
    }
</script>

<div
    bind:this={element}
    use:horizontalWheel={enabled}
    class={className}
    {...rest}
>
    {@render children?.()}
</div>
