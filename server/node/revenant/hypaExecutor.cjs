'use strict';

const fs = require('fs');
const path = require('path');
const { get_encoding } = require('@dqbd/tiktoken');

const REMOTE_HYPA_MODELS = new Set([
    'custom', 'ada', 'openai3small', 'openai3large',
    'voyage4large', 'voyageContext3', 'voyageContext4',
]);
const TOKENIZER_FILES = Object.freeze({
    mistral: ['sentencepiece', 'public/token/mistral/tokenizer.model'],
    novelai: ['sentencepiece', 'public/token/nai/nerdstash_v2.model'],
    claude: ['json', 'public/token/claude/claude.json'],
    llama: ['sentencepiece', 'public/token/llama/llama.model'],
    llama3: ['json', 'public/token/llama/llama3.json'],
    novellist: ['sentencepiece', 'public/token/trin/spiece.model'],
    gemma: ['sentencepiece', 'public/token/gemma/tokenizer.model'],
    cohere: ['json', 'public/token/cohere/tokenizer.json'],
    deepseek: ['json', 'public/token/deepseek/tokenizer.json'],
});

const tokenizerPromises = new Map();
let tikTokenizer;
let webTokenizerModule;

function exactArrayBuffer(buffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function getRegistryTokenizer(type) {
    if (type === 'tik') {
        tikTokenizer ??= get_encoding('cl100k_base');
        return tikTokenizer;
    }
    const definition = TOKENIZER_FILES[type];
    if (!definition) throw new Error(`Unsupported server tokenizer: ${type}`);
    let pending = tokenizerPromises.get(type);
    if (!pending) {
        pending = (async () => {
            // The package declares ESM but publishes a UMD bundle; Node's ESM
            // loader therefore exposes an empty namespace. Evaluate that UMD
            // bundle with its intended CommonJS bindings instead.
            if (!webTokenizerModule) {
                const entry = require.resolve('@mlc-ai/web-tokenizers');
                const source = await fs.promises.readFile(entry, 'utf8');
                const loaded = { exports: {} };
                new Function('exports', 'module', source)(loaded.exports, loaded);
                webTokenizerModule = loaded.exports;
            }
            const { Tokenizer } = webTokenizerModule;
            const bytes = exactArrayBuffer(await fs.promises.readFile(
                path.join(process.cwd(), definition[1]),
            ));
            return definition[0] === 'json'
                ? Tokenizer.fromJSON(bytes)
                : Tokenizer.fromSentencePiece(bytes);
        })();
        tokenizerPromises.set(type, pending);
        pending.catch(() => tokenizerPromises.delete(type));
    }
    return pending;
}

async function createSummaryTokenCounter(spec) {
    const tokenizer = await getRegistryTokenizer(spec.tokenizer);
    const additional = Math.max(0, Number(spec.chatAdditionalTokens) || 0);
    return async content => tokenizer.encode(String(content)).length + additional;
}

function splitBySeparator(text, separator) {
    try {
        const match = String(separator || '').match(/^\/(.+)\/([gimuy]*)$/);
        return match
            ? String(text).split(new RegExp(match[1], match[2]))
            : String(text).split(new RegExp(separator));
    } catch {
        return String(text).split('\n\n');
    }
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

async function requestJson(fetchImpl, url, headers, body, signal) {
    const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Embedding HTTP ${response.status}: ${JSON.stringify(data)}`);
    return data;
}

function chunk(values, size) {
    const result = [];
    for (let index = 0; index < values.length; index += size) {
        result.push(values.slice(index, index + size));
    }
    return result;
}

function createRemoteEmbedder(config, deps = {}) {
    if (!REMOTE_HYPA_MODELS.has(config.model)) {
        throw new Error(`Embedding model requires a client: ${config.model}`);
    }
    const fetchImpl = deps.fetch || globalThis.fetch;
    const sanitizeUrl = deps.sanitizeUrl || (value => value);

    async function standard(contents, inputType) {
        const output = [];
        for (const batch of chunk(contents, 50)) {
            let url;
            let headers;
            let body;
            if (config.model === 'custom') {
                const base = String(config.customUrl || '').replace(/\/+$/, '');
                url = base.endsWith('/embeddings') ? base : `${base}/embeddings`;
                url = sanitizeUrl(url);
                if (!url) throw new Error('Invalid custom embedding URL');
                headers = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
                body = { input: batch, ...(config.customModel ? { model: config.customModel } : {}) };
            } else if (config.model === 'voyage4large') {
                url = 'https://api.voyageai.com/v1/embeddings';
                headers = { authorization: `Bearer ${config.apiKey}` };
                body = { input: batch, model: 'voyage-4-large', input_type: inputType };
            } else {
                const models = {
                    ada: 'text-embedding-ada-002',
                    openai3small: 'text-embedding-3-small',
                    openai3large: 'text-embedding-3-large',
                };
                url = 'https://api.openai.com/v1/embeddings';
                headers = { authorization: `Bearer ${config.apiKey}` };
                body = { input: batch, model: models[config.model] };
            }
            const data = await requestJson(fetchImpl, url, headers, body, deps.signal);
            if (!Array.isArray(data.data)) throw new Error('Embedding response has no data array');
            output.push(...data.data.map(item => item.embedding));
        }
        return output;
    }

    async function contextualDocuments(groups) {
        const model = config.model === 'voyageContext3'
            ? 'voyage-context-3'
            : 'voyage-context-4';
        const output = [];
        for (const batch of chunk(groups, 1000)) {
            const data = await requestJson(
                fetchImpl,
                'https://api.voyageai.com/v1/contextualizedembeddings',
                { authorization: `Bearer ${config.apiKey}` },
                { model, inputs: batch, input_type: 'document' },
                deps.signal,
            );
            if (!Array.isArray(data.data)) throw new Error('Contextual embedding response has no data array');
            output.push(...data.data.map(group => group.data.map(item => item.embedding)));
        }
        return output;
    }

    async function contextualQueries(contents) {
        const model = config.model === 'voyageContext3'
            ? 'voyage-context-3'
            : 'voyage-context-4';
        const data = await requestJson(
            fetchImpl,
            'https://api.voyageai.com/v1/contextualizedembeddings',
            { authorization: `Bearer ${config.apiKey}` },
            { model, inputs: contents.map(value => [value]), input_type: 'query' },
            deps.signal,
        );
        return data.data.map(group => group.data[0].embedding);
    }

    return {
        async documents(chunksWithParent) {
            if (!['voyageContext3', 'voyageContext4'].includes(config.model)) {
                return standard(chunksWithParent.map(item => item.content), 'document');
            }
            const groups = [];
            const positions = [];
            const groupBySummary = new Map();
            for (let itemIndex = 0; itemIndex < chunksWithParent.length; itemIndex++) {
                const item = chunksWithParent[itemIndex];
                let groupIndex = groupBySummary.get(item.summaryIndex);
                if (groupIndex === undefined) {
                    groupIndex = groups.length;
                    groups.push([]);
                    positions.push({ summaryIndex: item.summaryIndex, chunkIndexes: [] });
                    groupBySummary.set(item.summaryIndex, groupIndex);
                }
                groups[groupIndex].push(item.content);
                positions[groupIndex].chunkIndexes.push(itemIndex);
            }
            const embeddedGroups = await contextualDocuments(groups);
            const flattened = new Array(chunksWithParent.length);
            for (let groupIndex = 0; groupIndex < positions.length; groupIndex++) {
                for (let index = 0; index < positions[groupIndex].chunkIndexes.length; index++) {
                    flattened[positions[groupIndex].chunkIndexes[index]] = embeddedGroups[groupIndex][index];
                }
            }
            return flattened;
        },
        queries(contents) {
            return ['voyageContext3', 'voyageContext4'].includes(config.model)
                ? contextualQueries(contents)
                : standard(contents, 'query');
        },
    };
}

async function selectHypaMemory(recipe, summaries, deps = {}) {
    const tokenize = deps.tokenize || await createSummaryTokenCounter(recipe.tokenizer);
    const embedder = deps.embedder || createRemoteEmbedder(recipe.embedding, deps);
    const settings = recipe.settings;
    const selected = new Set();
    const selectedImportant = [];
    const selectedRecent = [];
    const selectedSimilar = [];
    const selectedRandom = [];
    let available = recipe.availableMemoryTokens;

    for (let index = 0; index < summaries.length; index++) {
        if (!summaries[index].isImportant) continue;
        const tokens = await tokenize(`${summaries[index].text}\n\n`);
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
        const tokens = await tokenize(`${summaries[index].text}\n\n`);
        if (tokens + recentUsed > recentBudget) break;
        selected.add(index);
        selectedRecent.push(index);
        recentUsed += tokens;
    }

    let similarBudget = Math.floor(available * settings.similarMemoryRatio);
    if (randomRatio <= 0) similarBudget += recentBudget - recentUsed;
    let similarUsed = 0;
    if (settings.similarMemoryRatio > 0) {
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
        const recentChats = recipe.chats.slice(-settings.queryChatCount)
            .filter(chat => String(chat.content || '').trim());
        const queries = recentChats.flatMap((chat, chatIndex) => {
            const parts = String(chat.content).split('\n\n').map(value => value.trim()).filter(Boolean);
            const baseWeight = (chatIndex + 1)
                / ((recentChats.length * (recentChats.length + 1)) / 2);
            return parts.map(content => ({ content, weight: baseWeight / parts.length }));
        });
        if (chunks.length > 0 && queries.length > 0) {
            const [chunkVectors, queryVectors] = await Promise.all([
                embedder.documents(chunks),
                embedder.queries(queries.map(query => query.content)),
            ]);
            const rankedParents = parentRrf(
                weightedChunkRanking(chunkVectors, queryVectors, queries.map(query => query.weight)),
                chunks,
            );
            for (const summaryIndex of rankedParents) {
                const tokens = await tokenize(`${summaries[summaryIndex].text}\n\n`);
                if (tokens + similarUsed > similarBudget) break;
                selected.add(summaryIndex);
                selectedSimilar.push(summaryIndex);
                similarUsed += tokens;
            }
        }
    }

    let randomBudget = Math.floor(available * randomRatio)
        + (recentBudget - recentUsed) + (similarBudget - similarUsed);
    let randomUsed = 0;
    if (randomRatio > 0) {
        const candidates = seededShuffle(
            summaries.map((_, index) => index).filter(index => !selected.has(index)),
            recipe.randomSeed,
        );
        for (const summaryIndex of candidates) {
            const tokens = await tokenize(`${summaries[summaryIndex].text}\n\n`);
            if (tokens + randomUsed > randomBudget) continue;
            selected.add(summaryIndex);
            selectedRandom.push(summaryIndex);
            randomUsed += tokens;
        }
    }

    const selectedIndexes = [...selected].sort((a, b) => a - b);
    const memoryText = `<Past Events Summary>\n${selectedIndexes
        .map(index => summaries[index].text).join('\n\n')}\n</Past Events Summary>`;
    const realMemoryTokens = await tokenize(memoryText);
    let currentTokens = recipe.currentTokens;
    if (recipe.shouldReserveMemoryTokens) currentTokens -= recipe.memoryTokens;
    currentTokens += realMemoryTokens;
    if (currentTokens > recipe.maxContextTokens) {
        throw new Error(`Hypa selection exceeds context size: ${currentTokens} > ${recipe.maxContextTokens}`);
    }
    const memory = {
        summaries,
        ...(recipe.memory.categories ? { categories: recipe.memory.categories } : {}),
        ...(recipe.memory.modalSettings ? { modalSettings: recipe.memory.modalSettings } : {}),
        metrics: {
            lastImportantSummaries: selectedImportant,
            lastRecentSummaries: selectedRecent,
            lastSimilarSummaries: selectedSimilar,
            lastRandomSummaries: selectedRandom,
        },
    };
    return {
        currentTokens,
        memory,
        chatSequence: [
            { chat: { role: 'system', content: memoryText, memo: 'supaMemory' } },
            ...recipe.chats.slice(recipe.startIdx).map((chat, offset) => ({
                inputIndex: recipe.startIdx + offset,
                inputMemo: chat.memo,
            })),
        ],
    };
}

module.exports = {
    REMOTE_HYPA_MODELS,
    createRemoteEmbedder,
    createSummaryTokenCounter,
    selectHypaMemory,
};
