import tippy, { type Instance, type Placement } from 'tippy.js'
import 'tippy.js/dist/tippy.css';
import 'tippy.js/themes/translucent.css';

function normalizeTip(tip: string) {
    return (tip ?? '').trim()
}

function createTooltip(node: HTMLElement, tip: string, placement?: Placement) {
    let instance: Instance | null = null

    function update(newTip: string) {
        const content = normalizeTip(newTip)
        if (!content) {
            instance?.destroy()
            instance = null
            return
        }

        if (instance) {
            instance.setContent(content)
            return
        }

        instance = tippy(node, {
            content,
            animation: 'fade',
            arrow: true,
            theme: 'translucent',
            ...(placement ? { placement } : {}),
        })
    }

    update(tip)
    return {
        update,
        destroy() {
            instance?.destroy()
            instance = null
        },
    }
}

export function tooltip(node: HTMLElement, tip: string) {
    return createTooltip(node, tip)
}

export function tooltipRight(node: HTMLElement, tip: string) {
    return createTooltip(node, tip, 'right')
}
