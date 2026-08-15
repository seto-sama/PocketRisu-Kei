import { describe, expect, it } from 'vitest'

const componentSources = import.meta.glob('/src/lib/**/*.svelte', {
    eager: true,
    query: '?raw',
    import: 'default',
}) as Record<string, string>

const viewportUiPattern = /risu-modal-backdrop|position:\s*fixed\s*;|class(?::[\w-]+)?=["'][^"']*\bfixed\b/
const portalPattern = /<Portal\b|<[A-Za-z]+\.Portal\b/

const intentionalLayoutScopedFiles = [
    // App-level alert host: legacy overlays are already mounted directly under App.
    '/Others/AlertComp.svelte',
    // This is the sidebar's own dismiss surface, not an overlay rendered by sidebar content.
    '/SideBars/Sidebar.svelte',
]

describe('viewport UI portal coverage', () => {
    it('portals fixed overlays out of layout clipping and transform contexts', () => {
        const missingPortal = Object.entries(componentSources)
            .filter(([path, source]) => viewportUiPattern.test(source)
                && !portalPattern.test(source)
                && !intentionalLayoutScopedFiles.some(suffix => path.endsWith(suffix)))
            .map(([path]) => path)
            .sort()

        expect(missingPortal).toEqual([])
    })
})
