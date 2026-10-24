// HypaV3 memory selection shared by the browser and the Revenant server worker.

export const HYPA_MEMORY_PROMPT_TAG = 'Past Events Summary';
const SUMMARY_SEPARATOR = '\n\n';

/**
 * @typedef {{ content: string, summaryIndex: number }} HypaChunk
 * @typedef {{
 *   documents: (chunks: HypaChunk[]) => Promise<ArrayLike<number>[]>,
 *   queries: (contents: string[]) => Promise<ArrayLike<number>[]>,
 * }} HypaSelectionEmbedder
 * @typedef {{ role?: string, content: string, name?: string, memo?: string }} HypaQueryChat
 * @typedef {{
 *   settings: {
 *     recentMemoryRatio: number,
 *     similarMemoryRatio: number,
 *     queryChatCount: number,
 *     summaryChunkSeparator: string,
 *     queryMode?: 'chat' | 'paragraph',
 *   },
 *   chats: HypaQueryChat[],
 *   querySummary?: string,
 *   availableMemoryTokens: number,
 *   currentTokens: number,
 *   memoryTokens: number,
 *   shouldReserveMemoryTokens: boolean,
 *   maxContextTokens: number,
 *   randomSeed: string,
 * }} HypaSelectionRecipe
 * @typedef {{
 *   lastImportantSummaries: number[],
 *   lastRecentSummaries: number[],
 *   lastSimilarSummaries: number[],
 *   lastRandomSummaries: number[],
 * }} HypaSelectionMetrics
 */

/**
 * @param {string} text
 * @param {string} separator `/pattern/flags` or a plain RegExp source
 * @returns {string[]}
 */
export function splitBySeparator(text, separator) {
    try {
        const match = String(separator || '').match(/^\/(.+)\/([gimuy]*)$/);
        return match
            ? String(text).split(new RegExp(match[1], match[2]))
            : String(text).split(new RegExp(separator));
    } catch {
        return String(text).split('\n\n');
    }
}

/**
 * @template {HypaQueryChat} T
 * @param {T[]} chats
 * @param {number} count
 * @returns {T[]}
 */
export function getRecentHypaQueryChats(chats, count) {
    const recentChats = [];
    for (let index = chats.length - 1; index >= 0 && recentChats.length < count; index--) {
        const chat = chats[index];
        if (chat.memo === 'NewChat' || chat.memo === 'NewChatExample'
            || chat.name === 'example_user' || chat.name === 'example_assistant'
            || !String(chat.content || '').trim()) continue;
        recentChats.unshift(chat);
    }
    return recentChats;
}

/**
 * @param {string} content
 * @returns {string}
 */
export function wrapHypaMemoryPrompt(content) {
    return `<${HYPA_MEMORY_PROMPT_TAG}>\n${content}\n</${HYPA_MEMORY_PROMPT_TAG}>`;
}

function cosine(left, right) {
    let dot = 0;
    let magLeft = 0;
    let magRight = 0;
    for (let index = 0; index < left.length; index++) {
        dot += left[index] * right[index];
        magLeft += left[index] * left[index];
        magRight += right[index] * right[index];
    }
    return dot / (Math.sqrt(magLeft) * Math.sqrt(magRight));
}

function hasVectors(vectors, count) {
    return Array.isArray(vectors) && vectors.length === count
        && vectors.every(vector => vector && vector.length > 0);
}

function weightedChunkRanking(chunkVectors, queryVectors, queryWeights) {
    const scores = new Map();
    for (let queryIndex = 0; queryIndex < queryVectors.length; queryIndex++) {
        for (let chunkIndex = 0; chunkIndex < chunkVectors.length; chunkIndex++) {
            const score = cosine(queryVectors[queryIndex], chunkVectors[chunkIndex]);
            scores.set(
                chunkIndex,
                (scores.get(chunkIndex) || 0) + score * queryWeights[queryIndex],
            );
        }
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([index]) => index);
}

function parentRrf(rankedChunkIndexes, chunks) {
    const scores = new Map();
    for (let index = 0; index < rankedChunkIndexes.length; index++) {
        const summaryIndex = chunks[rankedChunkIndexes[index]].summaryIndex;
        scores.set(summaryIndex, (scores.get(summaryIndex) || 0) + 1 / (61 + index));
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([index]) => index);
}

function seededShuffle(values, seed) {
    let state = 2166136261;
    for (const character of String(seed || 'revenant')) {
        state ^= character.charCodeAt(0);
        state = Math.imul(state, 16777619) >>> 0;
    }
    const next = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x100000000;
    };
    const result = [...values];
    for (let index = result.length - 1; index > 0; index--) {
        const target = Math.floor(next() * (index + 1));
        [result[index], result[target]] = [result[target], result[index]];
    }
    return result;
}

function buildQueries(recipe) {
    const recentChats = getRecentHypaQueryChats(recipe.chats, recipe.settings.queryChatCount);
    const queryChats = recipe.querySummary
        ? [...recentChats, { content: recipe.querySummary }]
        : recentChats;
    const totalWeight = (queryChats.length * (queryChats.length + 1)) / 2;
    return queryChats.flatMap((chat, chatIndex) => {
        const weight = (chatIndex + 1) / totalWeight;
        if (recipe.settings.queryMode === 'chat') {
            return [{ content: String(chat.content), weight }];
        }
        const parts = String(chat.content).split('\n\n').map(value => value.trim()).filter(Boolean);
        return parts.map(content => ({ content, weight: weight / parts.length }));
    });
}

/**
 * @param {HypaSelectionRecipe} recipe
 * @param {{ text: string, isImportant: boolean }[]} summaries
 * @param {{ tokenize: (content: string) => Promise<number>, embedder: HypaSelectionEmbedder }} deps
 * @returns {Promise<{ currentTokens: number, memoryText: string, metrics: HypaSelectionMetrics }>}
 */
export async function selectHypaSummaries(recipe, summaries, { tokenize, embedder }) {
    const settings = recipe.settings;
    const summaryTokens = index => tokenize(`${summaries[index].text}${SUMMARY_SEPARATOR}`);
    const selected = new Set();
    const selectedImportant = [];
    const selectedRecent = [];
    const selectedSimilar = [];
    const selectedRandom = [];
    let available = recipe.availableMemoryTokens;

    for (let index = 0; index < summaries.length; index++) {
        if (!summaries[index].isImportant) continue;
        const tokens = await summaryTokens(index);
        if (tokens > available) break;
        selected.add(index);
        selectedImportant.push(index);
        available -= tokens;
    }

    const randomRatio = 1 - settings.recentMemoryRatio - settings.similarMemoryRatio;
    const recentBudget = Math.floor(available * settings.recentMemoryRatio);
    let recentUsed = 0;
    for (let index = summaries.length - 1; index >= 0; index--) {
        if (selected.has(index)) continue;
        const tokens = await summaryTokens(index);
        if (tokens + recentUsed > recentBudget) break;
        selected.add(index);
        selectedRecent.push(index);
        recentUsed += tokens;
    }

    let similarBudget = Math.floor(available * settings.similarMemoryRatio);
    if (randomRatio <= 0) similarBudget += recentBudget - recentUsed;
    let similarUsed = 0;
    if (settings.similarMemoryRatio > 0) {
        /** @type {HypaChunk[]} */
        const chunks = [];
        for (let summaryIndex = 0; summaryIndex < summaries.length; summaryIndex++) {
            if (selected.has(summaryIndex)) continue;
            for (const content of splitBySeparator(
                summaries[summaryIndex].text,
                settings.summaryChunkSeparator,
            ).map(value => value.trim()).filter(Boolean)) {
                chunks.push({ content, summaryIndex });
            }
        }
        const queries = buildQueries(recipe);
        if (chunks.length > 0 && queries.length > 0) {
            const [chunkVectors, queryVectors] = await Promise.all([
                embedder.documents(chunks),
                embedder.queries(queries.map(query => query.content)),
            ]);
            if (!hasVectors(chunkVectors, chunks.length) || !hasVectors(queryVectors, queries.length)) {
                throw new Error('Embedding response did not return a vector for every input');
            }
            const rankedParents = parentRrf(
                weightedChunkRanking(chunkVectors, queryVectors, queries.map(query => query.weight)),
                chunks,
            );
            for (const summaryIndex of rankedParents) {
                const tokens = await summaryTokens(summaryIndex);
                if (tokens + similarUsed > similarBudget) break;
                selected.add(summaryIndex);
                selectedSimilar.push(summaryIndex);
                similarUsed += tokens;
            }
        }
    }

    const randomBudget = Math.floor(available * randomRatio)
        + (recentBudget - recentUsed) + (similarBudget - similarUsed);
    let randomUsed = 0;
    if (randomRatio > 0) {
        const candidates = seededShuffle(
            summaries.map((_, index) => index).filter(index => !selected.has(index)),
            recipe.randomSeed,
        );
        for (const summaryIndex of candidates) {
            const tokens = await summaryTokens(summaryIndex);
            // Keep scanning for summaries that fit the remaining budget.
            if (tokens + randomUsed > randomBudget) continue;
            selected.add(summaryIndex);
            selectedRandom.push(summaryIndex);
            randomUsed += tokens;
        }
    }

    const memoryText = wrapHypaMemoryPrompt([...selected].sort((a, b) => a - b)
        .map(index => summaries[index].text).join(SUMMARY_SEPARATOR));
    let currentTokens = recipe.currentTokens;
    if (recipe.shouldReserveMemoryTokens) currentTokens -= recipe.memoryTokens;
    currentTokens += await tokenize(memoryText);
    if (currentTokens > recipe.maxContextTokens) {
        throw new Error(`Hypa selection exceeds context size: ${currentTokens} > ${recipe.maxContextTokens}`);
    }
    return {
        currentTokens,
        memoryText,
        metrics: {
            lastImportantSummaries: selectedImportant,
            lastRecentSummaries: selectedRecent,
            lastSimilarSummaries: selectedSimilar,
            lastRandomSummaries: selectedRandom,
        },
    };
}
