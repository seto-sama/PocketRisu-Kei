export const COMFY_HTTP_ROUTES = [
    ['/prompt', 'POST'],
    ['/history', 'GET'],
    ['/view', 'GET'],
] as const

export function createComfyUrl(base: string, path: string, query?: Record<string, string>): URL {
    const root = new URL(base)
    if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password) {
        throw new Error('Invalid local ComfyUI URL')
    }
    const url = base.endsWith('/api') ? new URL(`${base}${path}`) : new URL(path, root)
    if (query) url.search = new URLSearchParams(query).toString()
    return url
}
