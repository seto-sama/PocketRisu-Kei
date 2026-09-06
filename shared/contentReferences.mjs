/** @typedef {'inlay' | 'translation'} ContentReferenceKind */

// Shared with renderers and both sides of reference scanning.
export const inlayTokenRegex = /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g;

export function isContentReferenceKind(kind) {
    return kind === 'inlay' || kind === 'translation';
}

/** @param {ContentReferenceKind} kind */
export function createContentReferenceCollector(kind) {
    if (!isContentReferenceKind(kind)) throw new Error('Invalid content reference kind');
    /** @type {Record<string, number>} */
    const refCounts = Object.create(null);
    /** @type {Set<string>} */
    const keys = new Set();
    const pattern = new RegExp(inlayTokenRegex.source, 'g');
    let totalMessages = 0;

    function addText(text, isComment = false) {
        if (typeof text !== 'string') return;
        if (kind === 'translation') {
            if (!isComment && text.trim()) keys.add(text);
        } else {
            for (const match of text.matchAll(pattern)) {
                refCounts[match[2]] = (refCounts[match[2]] ?? 0) + 1;
            }
        }
    }

    function addChat(chat) {
        if (chat?._placeholder) return;
        for (const message of chat?.message ?? []) {
            totalMessages++;
            addText(message.data, message.isComment);
            for (const swipe of message.swipes ?? []) addText(swipe, message.isComment);
        }
        for (const summary of chat?.hypaV3Data?.summaries ?? []) addText(summary.text);
    }

    function addCharacter(character) {
        addText(character.firstMessage);
        for (const greeting of character.alternateGreetings ?? []) addText(greeting);
        for (const chat of character.chats ?? []) addChat(chat);
    }

    function result() {
        const common = { kind, scannedAt: Date.now(), totalMessages };
        return kind === 'inlay'
            ? { ...common, refCounts }
            : { ...common, keys: [...keys] };
    }
    return { addCharacter, addChat, result };
}

/** Candidates are supplied by the caller; never enumerate server-only text/ids. */
export function validateReferenceCandidates(kind, candidates) {
    if (!isContentReferenceKind(kind) || !Array.isArray(candidates)
        || candidates.some(value => typeof value !== 'string')) {
        throw new Error('Invalid content reference candidates');
    }
}

export function matchContentReferences(result, candidates) {
    const keys = result.kind === 'translation' ? new Set(result.keys) : null;
    return {
        kind: result.kind,
        scannedAt: result.scannedAt,
        used: candidates.map(value => keys ? keys.has(value) : (result.refCounts[value] ?? 0) > 0),
    };
}

/** Reject incomplete responses rather than authorizing cleanup. */
export function validateContentReferences(value, kind, candidates) {
    validateReferenceCandidates(kind, candidates);
    if (value?.kind !== kind || !Number.isFinite(value.scannedAt)
        || !Array.isArray(value.used) || value.used.length !== candidates.length
        || value.used.some(used => typeof used !== 'boolean')) {
        throw new Error('Invalid content reference scan response');
    }
    // Reconstruct references only from data this client already had. Never
    // propagate unexpected response properties from a stale/malformed server.
    const known = candidates.filter((_, index) => value.used[index]);
    return kind === 'translation'
        ? { kind, scannedAt: value.scannedAt, keys: known }
        : { kind, scannedAt: value.scannedAt, refCounts: Object.fromEntries(known.map(id => [id, 1])) };
}
