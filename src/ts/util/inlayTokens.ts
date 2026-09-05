// Centralized regex for matching inlay tokens in chat content.
// Used by both renderer/parsers and summarization sanitizers.
export const inlayTokenRegex = /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g;
export const INLAY_VIEWER_ID_ATTRIBUTE = 'data-inlay-viewer-id';

/** Canonicalize newly saved legacy display-only references without migrating stored chats. */
export function canonicalizeInlayTokens(value: string): string {
    return value.replace(inlayTokenRegex, (token, type: string, id: string) =>
        type === 'inlay' ? `{{inlayed::${id}}}` : token
    )
}
