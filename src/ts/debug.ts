declare global {
    var __POCKETRISU_DEBUG__: boolean | undefined
}

export function isDebugEnabled(): boolean {
    return globalThis.__POCKETRISU_DEBUG__ === true
}
