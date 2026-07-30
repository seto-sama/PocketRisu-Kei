import tippy from 'tippy.js'
import 'tippy.js/dist/tippy.css';
import 'tippy.js/themes/translucent.css';

function normalizeTip(tip: string) {
    return (tip ?? '').trim()
}

export function tooltip(node:HTMLElement, tip:string) {
    const content = normalizeTip(tip)
    const instance = tippy(node, {
        content,
        animation: 'fade',
        arrow: true,
        theme: 'translucent',
    })
    if (!content) instance.disable()

    return {
        update(newTip: string) {
            const newContent = normalizeTip(newTip)
            if (!newContent) {
                instance.disable()
                return
            }
            instance.setContent(newContent)
            instance.enable()
        },
        destroy() {
            instance.destroy()
        }
    };
}

export function tooltipRight(node:HTMLElement, tip:string) {
    const content = normalizeTip(tip)
    const instance = tippy(node, {
        content,
        animation: 'fade',
        arrow: true,
        placement: 'right',
        theme: 'translucent',
    })
    if (!content) instance.disable()

    return {
        update(newTip: string) {
            const newContent = normalizeTip(newTip)
            if (!newContent) {
                instance.disable()
                return
            }
            instance.setContent(newContent)
            instance.enable()
        },
        destroy() {
            instance.destroy()
        }
    };
}
