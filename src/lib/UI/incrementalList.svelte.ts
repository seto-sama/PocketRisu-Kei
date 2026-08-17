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

    function observeSentinel(node: HTMLElement, initialTotal: number) {
        let total = initialTotal;
        let observer: IntersectionObserver | null = null;
        let destroyed = false;
        const supportsObservation = typeof IntersectionObserver !== 'undefined';

        const observe = () => {
            if(destroyed){
                return;
            }
            if(displayCount < total){
                observer?.observe(node);
            }
            else {
                observer?.unobserve(node);
            }
        };

        if(!supportsObservation){
            displayCount = total;
        }
        else {
            observer = new IntersectionObserver((entries) => {
                if(!entries[0]?.isIntersecting){
                    return;
                }
                observer?.unobserve(node);
                displayCount = Math.min(displayCount + pageSize, total);
                queueMicrotask(observe);
            }, {
                root: options.getRoot?.(node) ?? null,
                rootMargin,
                threshold: 0,
            });
            observe();
        }

        return {
            update(nextTotal: number) {
                total = nextTotal;
                if(supportsObservation){
                    observe();
                }
                else {
                    displayCount = total;
                }
            },
            destroy() {
                destroyed = true;
                observer?.disconnect();
            },
        };
    }

    return {
        slice,
        hasMore,
        reset,
        observeSentinel,
    };
}
