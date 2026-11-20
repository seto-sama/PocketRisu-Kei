import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';

interface IncrementalListOptions {
    pageSize: number;
    rootMargin?: string;
    getRoot?: (sentinel: HTMLElement) => Element | Document | null;
}

export function createIncrementalList(options: IncrementalListOptions) {
    const pageSize = options.pageSize;
    const rootMargin = options.rootMargin ?? '200px 0px';
    let displayCount = $state(pageSize);

    function slice<T>(items: T[]): T[] {
        return items.slice(0, displayCount);
    }

    function hasMore(total: number): boolean {
        return displayCount < total;
    }

    function reset() {
        displayCount = pageSize;
    }

    const observeSentinel = (total: number): Attachment<HTMLElement> => (node) => {
        if(typeof IntersectionObserver === 'undefined'){
            displayCount = total;
            return;
        }

        let destroyed = false;
        const observe = () => {
            if(destroyed){
                return;
            }
            if(displayCount < total){
                observer.observe(node);
            }
            else {
                observer.unobserve(node);
            }
        };
        const observer = new IntersectionObserver((entries) => {
            if(!entries[0]?.isIntersecting){
                return;
            }
            observer.unobserve(node);
            displayCount = Math.min(displayCount + pageSize, total);
            queueMicrotask(observe);
        }, {
            root: options.getRoot?.(node) ?? null,
            rootMargin,
            threshold: 0,
        });
        // Re-run only when total changes, not on every page load.
        untrack(observe);

        return () => {
            destroyed = true;
            observer.disconnect();
        };
    };

    return {
        slice,
        hasMore,
        reset,
        observeSentinel,
    };
}
