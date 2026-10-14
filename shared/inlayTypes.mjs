/**
 * @param {unknown} type
 * @returns {type is 'image' | 'video' | 'audio'}
 */
export function isInlayMediaType(type) {
    return type === 'image' || type === 'video' || type === 'audio'
}

export function getInlayThumbnailScale(width, height) {
    return Math.min(1, 640 / Math.max(width, height), 320 / Math.min(width, height));
}
