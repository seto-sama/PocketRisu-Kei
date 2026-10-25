'use strict';

const fs = require('fs');
const path = require('path');
const { get_encoding } = require('@dqbd/tiktoken');
const { selectHypaSummaries } = require('../../shared/hypaSelection.mjs');

const EMBEDDING_BATCH_SIZE = 50;
const CONTEXTUAL_EMBEDDING_GROUP_BATCH_SIZE = 1000;
const REMOTE_HYPA_MODELS = new Set([
    'custom', 'ada', 'openai3small', 'openai3large',
    'voyage4large', 'voyageContext3', 'voyageContext4',
]);
const TOKENIZER_FILES = Object.freeze({
    claude: 'token/claude/claude.json',
    llama3: 'token/llama/llama3.json',
    gemma: 'token/gemma/tokenizer.json',
    deepseek: 'token/deepseek/tokenizer.json',
});
const LEGACY_TOKENIZERS = new Set(['mistral', 'novelai', 'llama', 'novellist']);
const SERVER_HYPA_TOKENIZERS = new Set(['tik', ...LEGACY_TOKENIZERS, ...Object.keys(TOKENIZER_FILES)]);

const tokenizerPromises = new Map();
let tikTokenizer;

async function getRegistryTokenizer(type) {
    if (type === 'tik' || LEGACY_TOKENIZERS.has(type)) {
        tikTokenizer ??= get_encoding('o200k_base');
        return tikTokenizer;
    }
    const definition = TOKENIZER_FILES[type];
    if (!definition) throw new Error(`Unsupported server tokenizer: ${type}`);
    let pending = tokenizerPromises.get(type);
    if (!pending) {
        pending = (async () => {
            const { Tokenizer } = await import('@huggingface/tokenizers');
            const config = JSON.parse(await fs.promises.readFile(
                path.join(process.cwd(), 'dist', definition),
                'utf8',
            ));
            return new Tokenizer(config, {});
        })();
        tokenizerPromises.set(type, pending);
        pending.catch(() => tokenizerPromises.delete(type));
    }
    return pending;
}

async function createSummaryTokenCounter(spec) {
    const tokenizer = await getRegistryTokenizer(spec.tokenizer);
    const additional = Math.max(0, Number(spec.chatAdditionalTokens) || 0);
    const usesJsonTokenizer = Boolean(TOKENIZER_FILES[spec.tokenizer]);
    return async content => {
        const encoded = usesJsonTokenizer
            ? tokenizer.encode(String(content), { add_special_tokens: false }).ids
            : tokenizer.encode(String(content));
        return encoded.length + additional;
    };
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
        throw new Error(`Unsupported embedding model: ${config.model}`);
    }
    const fetchImpl = deps.fetch || globalThis.fetch;
    const sanitizeUrl = deps.sanitizeUrl || (value => value);
    const maxConcurrent = Number.isInteger(config.maxConcurrent)
        ? Math.max(1, config.maxConcurrent)
        : 1;
    let activeRequests = 0;
    const requestQueue = [];

    function drainRequestQueue() {
        while (activeRequests < maxConcurrent && requestQueue.length > 0) {
            const { task, resolve, reject } = requestQueue.shift();
            activeRequests++;
            Promise.resolve()
                .then(task)
                .then(resolve, reject)
                .finally(() => {
                    activeRequests--;
                    drainRequestQueue();
                });
        }
    }

    function runRequest(task) {
        return new Promise((resolve, reject) => {
            requestQueue.push({ task, resolve, reject });
            drainRequestQueue();
        });
    }

    async function standard(contents, inputType) {
        const batches = chunk(contents, EMBEDDING_BATCH_SIZE);
        const results = await Promise.all(batches.map(batch => runRequest(async () => {
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
            return data.data.map(item => item.embedding);
        })));
        return results.flat();
    }

    async function contextualDocuments(groups) {
        const model = config.model === 'voyageContext3'
            ? 'voyage-context-3'
            : 'voyage-context-4';
        const batches = chunk(groups, CONTEXTUAL_EMBEDDING_GROUP_BATCH_SIZE);
        const results = await Promise.all(batches.map(batch => runRequest(async () => {
            const data = await requestJson(
                fetchImpl,
                'https://api.voyageai.com/v1/contextualizedembeddings',
                { authorization: `Bearer ${config.apiKey}` },
                { model, inputs: batch, input_type: 'document' },
                deps.signal,
            );
            if (!Array.isArray(data.data)) throw new Error('Contextual embedding response has no data array');
            return data.data.map(group => group.data.map(item => item.embedding));
        })));
        return results.flat();
    }

    async function contextualQueries(contents) {
        const model = config.model === 'voyageContext3'
            ? 'voyage-context-3'
            : 'voyage-context-4';
        const results = await Promise.all(chunk(contents, EMBEDDING_BATCH_SIZE).map(batch => runRequest(async () => {
            const data = await requestJson(
                fetchImpl,
                'https://api.voyageai.com/v1/contextualizedembeddings',
                { authorization: `Bearer ${config.apiKey}` },
                { model, inputs: batch.map(value => [value]), input_type: 'query' },
                deps.signal,
            );
            if (!Array.isArray(data.data)) throw new Error('Contextual embedding response has no data array');
            return data.data.map(group => group.data[0].embedding);
        })));
        return results.flat();
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
    const embedder = deps.embedder || createRemoteEmbedder({
        ...recipe.embedding,
        maxConcurrent: recipe.settings.embeddingMaxConcurrent,
    }, deps);
    const selection = await selectHypaSummaries(recipe, summaries, { tokenize, embedder });
    return {
        currentTokens: selection.currentTokens,
        memory: {
            summaries,
            ...(recipe.memory.categories ? { categories: recipe.memory.categories } : {}),
            ...(recipe.memory.modalSettings ? { modalSettings: recipe.memory.modalSettings } : {}),
            metrics: selection.metrics,
        },
        chatSequence: [
            { chat: { role: 'system', content: selection.memoryText, memo: 'supaMemory' } },
            ...recipe.chats.slice(recipe.startIdx).map((chat, offset) => ({
                inputIndex: recipe.startIdx + offset,
                inputMemo: chat.memo,
            })),
        ],
    };
}

module.exports = {
    REMOTE_HYPA_MODELS,
    SERVER_HYPA_TOKENIZERS,
    createRemoteEmbedder,
    createSummaryTokenCounter,
    selectHypaMemory,
};
