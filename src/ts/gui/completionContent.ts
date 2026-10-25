export interface CompletionContent {
    label: string
    detail?: string
    description?: string
}

// Native fields and CodeMirror use the same markup for completion rows.
export function completionContent(node: HTMLElement, content: CompletionContent) {
    node.classList.add('risu-completion-content')
    function update(content: CompletionContent) {
        const children = (['label', 'detail', 'description'] as const).flatMap(key => {
            if (!content[key]) return []
            const span = document.createElement('span')
            span.className = `risu-completion-${key}`
            span.textContent = content[key]
            return [span]
        })
        node.replaceChildren(...children)
    }
    update(content)
    return { update }
}

export function renderCompletionContent(content: CompletionContent) {
    const node = document.createElement('span')
    completionContent(node, content)
    return node
}
