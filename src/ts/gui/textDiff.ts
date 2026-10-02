let diffModulePromise: Promise<typeof import('diff')> | null = null

export function loadDiffModule(): Promise<typeof import('diff')> {
    return (diffModulePromise ??= import('diff'))
}

export function visibleDiffLines(
    changed: boolean[],
    showOnlyChanges: boolean,
    contextRadius: number,
    expandedRanges: Array<{ from: number, to: number }> = [],
): boolean[] {
    const visible = new Array<boolean>(changed.length).fill(!showOnlyChanges)
    if (!showOnlyChanges) return visible
    const reveal = (from: number, to: number) => {
        for (let index = Math.max(0, from); index <= Math.min(changed.length - 1, to); index++) {
            visible[index] = true
        }
    }
    changed.forEach((isChanged, index) => {
        if (isChanged) reveal(index - contextRadius, index + contextRadius)
    })
    for (const range of expandedRanges) reveal(range.from, range.to)
    return visible
}
