/**
 * @param {unknown} type
 * @returns {type is 'image' | 'video' | 'audio'}
 */
export function isInlayMediaType(type) {
    return type === 'image' || type === 'video' || type === 'audio'
}
