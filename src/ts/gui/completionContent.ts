import type { Attachment } from 'svelte/attachments'

export interface CompletionContent {
    label: string
    detail?: string
    description?: string
}

// Native fields and CodeMirror use the same markup for completion rows.
export function completionContent(content: CompletionContent): Attachment<HTMLElement> {
    return (node) => {
        node.classList.add('risu-completion-content')
        const children = (['label', 'detail', 'description'] as const).flatMap(key => {
            if (!content[key]) return []
            const span = document.createElement('span')
            span.className = `risu-completion-${key}`
            span.textContent = content[key]
            return [span]
        })
        node.replaceChildren(...children)
    }
}

export function renderCompletionContent(content: CompletionContent) {
    const node = document.createElement('span')
    completionContent(content)(node)
    return node
}
