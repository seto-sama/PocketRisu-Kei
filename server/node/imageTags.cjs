'use strict';

// Source: mengod-hf/danbooru-tags-kr (normal CSV; downloaded unchanged).
// https://huggingface.co/datasets/mengod-hf/danbooru-tags-kr
// Korean localization: CC BY-SA 4.0, https://creativecommons.org/licenses/by-sa/4.0/
// Earlier translations: nyantong; upstream CSV: PYU224; Japanese translations: boorutan.
// Complete license and third-party attribution:
// https://huggingface.co/datasets/mengod-hf/danbooru-tags-kr/blob/main/LICENSE

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const DATASET_ID = 'mengod-hf/danbooru-tags-kr';
const IMAGE_TAG_SOURCE = {
    repository: `https://huggingface.co/datasets/${DATASET_ID}`,
    apiUrl: `https://huggingface.co/api/datasets/${DATASET_ID}?blobs=true`,
};
const MAX_CSV_BYTES = 32 * 1024 * 1024;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NORMAL_CSV_NAME = /^danbooru-tags-kr(?:-(\d{4}-\d{2}-\d{2})(?:-v(\d+))?)?\.csv$/;

function normalize(text) {
    return text.normalize('NFC').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

// This dataset has no header. Quoted descriptions may contain commas and newlines.
function parseImageTags(csv) {
    const tags = [];
    let row = [];
    let field = '';
    let quoted = false;
    const finishRow = () => {
        row.push(field);
        field = '';
        if (row.length === 1 && !row[0].trim()) { row = []; return; }
        const [name, category, count, description] = row;
        if (row.length !== 4 || !name.trim() || !/^(0|1|3|4|5)$/.test(category) || !/^\d+$/.test(count)) {
            throw new Error('Invalid image tag CSV row');
        }
        tags.push({ name, category: Number(category), count: Number(count), description,
            searchName: normalize(name), searchDescription: normalize(description) });
        row = [];
    };
    csv = csv.replace(/^\uFEFF/, '');
    for (let index = 0; index < csv.length; index += 1) {
        const char = csv[index];
        if (char === '"') {
            if (quoted && csv[index + 1] === '"') { field += '"'; index += 1; }
            else quoted = !quoted;
        } else if (!quoted && char === ',') {
            row.push(field);
            field = '';
        } else if (!quoted && (char === '\n' || char === '\r')) {
            if (char === '\r' && csv[index + 1] === '\n') index += 1;
            finishRow();
        } else field += char;
    }
    if (quoted) throw new Error('Unterminated image tag CSV field');
    if (field || row.length) finishRow();
    if (!tags.length) throw new Error('Empty image tag CSV');
    return tags.sort((a, b) => b.count - a.count);
}

function searchImageTags(tags, query, limit = 20) {
    query = normalize(query);
    if (!query) return [];
    const matches = [[], [], [], []];
    for (const tag of tags) {
        const rank = tag.searchName === query ? 0
            : tag.searchName.startsWith(query) ? 1
            : tag.searchName.includes(query) ? 2
            : tag.searchDescription.includes(query) ? 3 : -1;
        if (rank >= 0 && matches[rank].length < limit) {
            const { name, category, count, description } = tag;
            matches[rank].push({ name, category, count, description });
        }
    }
    return matches.flat().slice(0, limit);
}

function validSource(source) {
    return source && /^[a-f0-9]{40}$/.test(source.revision)
        && NORMAL_CSV_NAME.test(source.filename)
        && (source.algorithm === 'sha256' ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{40}$/).test(source.checksum)
        && ['sha256', 'git-sha1'].includes(source.algorithm);
}

function selectImageTagSource(metadata) {
    const candidates = (metadata.siblings ?? [])
        .map(file => ({ file, match: NORMAL_CSV_NAME.exec(file.rfilename) }))
        .filter(entry => entry.match)
        .sort((a, b) => (b.match[1] ?? '').localeCompare(a.match[1] ?? '')
            || Number(b.match[2] ?? 0) - Number(a.match[2] ?? 0));
    const file = candidates[0]?.file;
    const source = file && {
        revision: metadata.sha,
        filename: file.rfilename,
        algorithm: file.lfs ? 'sha256' : 'git-sha1',
        checksum: file.lfs?.sha256 ?? file.blobId,
    };
    if (!validSource(source) || !Number.isFinite(file.size) || file.size > MAX_CSV_BYTES) {
        throw new Error('Unsupported image tag dataset metadata');
    }
    return source;
}

function validChecksum(bytes, source) {
    const hash = createHash(source.algorithm === 'git-sha1' ? 'sha1' : 'sha256');
    if (source.algorithm === 'git-sha1') hash.update(`blob ${bytes.length}\0`);
    return hash.update(bytes).digest('hex') === source.checksum;
}

function createImageTagService({ cacheDir, fetchImpl = fetch, now = Date.now }) {
    const metadataPath = path.join(cacheDir, 'metadata.json');
    const csvPath = descriptor => path.join(cacheDir, `${descriptor.checksum}.csv`);
    let tags;
    let cachedSource;
    let lastCheckedAt = 0;
    let hydratePromise;
    let refreshPromise;

    async function fetchBytes(url, limit, timeoutMs) {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
        if (!response.ok || !response.body) throw new Error(`Image tag download failed: HTTP ${response.status}`);
        const chunks = [];
        let size = 0;
        const reader = response.body.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > limit) {
                    await reader.cancel();
                    throw new Error('Image tag download exceeds size limit');
                }
                chunks.push(value);
            }
        } finally { reader.releaseLock(); }
        return Buffer.concat(chunks);
    }

    async function writeAtomic(filePath, bytes) {
        await fs.mkdir(cacheDir, { recursive: true });
        const temporaryPath = `${filePath}.tmp`;
        try {
            await fs.writeFile(temporaryPath, bytes);
            await fs.rename(temporaryPath, filePath);
        } finally { await fs.rm(temporaryPath, { force: true }); }
    }

    async function hydrate() {
        hydratePromise ??= (async () => {
            try {
                const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
                if (metadata.schemaVersion !== 1 || !validSource(metadata.source) || !Number.isFinite(metadata.checkedAt)) return;
                const bytes = await fs.readFile(csvPath(metadata.source));
                if (!validChecksum(bytes, metadata.source)) return;
                tags = parseImageTags(bytes.toString('utf8'));
                cachedSource = metadata.source;
                lastCheckedAt = metadata.checkedAt;
            } catch { /* A missing or corrupt cache can be replaced by a fresh download. */ }
        })();
        await hydratePromise;
    }

    async function refresh() {
        if (refreshPromise) return refreshPromise;
        lastCheckedAt = now();
        refreshPromise = (async () => {
            try {
                const metadata = JSON.parse((await fetchBytes(IMAGE_TAG_SOURCE.apiUrl, 2 * 1024 * 1024, 20_000)).toString('utf8'));
                const latest = selectImageTagSource(metadata);
                if (cachedSource?.checksum !== latest.checksum) {
                    const bytes = await fetchBytes(`${IMAGE_TAG_SOURCE.repository}/resolve/${latest.revision}/${latest.filename}`, MAX_CSV_BYTES, 90_000);
                    if (!validChecksum(bytes, latest)) throw new Error('Image tag CSV checksum mismatch');
                    const nextTags = parseImageTags(bytes.toString('utf8'));
                    await writeAtomic(csvPath(latest), bytes);
                    tags = nextTags;
                }
                const previous = cachedSource;
                cachedSource = latest;
                await writeAtomic(metadataPath, JSON.stringify({ schemaVersion: 1, checkedAt: lastCheckedAt, source: cachedSource }));
                if (previous && previous.checksum !== latest.checksum) await fs.rm(csvPath(previous), { force: true }).catch(() => {});
            } catch (error) {
                if (!tags) throw error;
                // Failed checks are also throttled, including across server restarts.
                await writeAtomic(metadataPath, JSON.stringify({ schemaVersion: 1, checkedAt: lastCheckedAt, source: cachedSource })).catch(() => {});
            }
        })().finally(() => { refreshPromise = undefined; });
        return refreshPromise;
    }

    return {
        async search(query) {
            if (!normalize(query)) return [];
            await hydrate();
            if (!tags) await refresh();
            else if (now() - lastCheckedAt >= REFRESH_INTERVAL_MS) void refresh();
            return searchImageTags(tags, query);
        },
    };
}

module.exports = { IMAGE_TAG_SOURCE, parseImageTags, searchImageTags, selectImageTagSource, createImageTagService };
