export type ImageOrientation = 'landscape' | 'portrait'

export function isImageOrientation(value: unknown): value is ImageOrientation {
    return value === 'landscape' || value === 'portrait'
}

export function orientImageDimensions(width: number, height: number, orientation?: ImageOrientation) {
    if (orientation === undefined) return { width, height }
    const longer = Math.max(width, height)
    const shorter = Math.min(width, height)
    return orientation === 'landscape'
        ? { width: longer, height: shorter }
        : { width: shorter, height: longer }
}
