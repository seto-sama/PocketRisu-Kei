import { untrack } from 'svelte'

type AutoSizeTextareaOptions = {
    element: () => HTMLTextAreaElement | undefined
    text: () => string
    enabled?: () => boolean
    maxHeight?: () => number
    onResize: (height: number, overflow: boolean) => void
}

export function autoSizeTextarea(options: AutoSizeTextareaOptions) {
    $effect(() => {
        if (options.enabled && !options.enabled()) return
        options.text()
        const element = options.element()
        if (!element) return

        untrack(() => {
            const previousHeight = element.style.height
            element.style.height = '0px'
            const contentHeight = element.scrollHeight
            element.style.height = previousHeight
            const maxHeight = options.maxHeight?.() ?? Infinity
            options.onResize(Math.min(contentHeight, maxHeight), contentHeight > maxHeight)
        })
    })
}
