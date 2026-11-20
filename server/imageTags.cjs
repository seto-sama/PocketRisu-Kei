'use strict';

// Source: mengod-hf/danbooru-tags-kr ("with related tags" CSV; downloaded unchanged).
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
const SEARCH_LIMIT = 20;
const TAG_CSV_NAME = /^with related tags\/danbooru-tags-wrt-kr(?:-(\d{4}-\d{2}-\d{2})(?:-v(\d+))?)?\.csv$/;
// The Danbooru dataset lacks NovelAI V5-only tags. Categories follow similar dataset tags
// (alpha transparency and visual novel cg are meta).
const NOVELAI_TAGS = [
    ['depthness', 0, '[NAI V5 > 음영] 이미지의 음영에 더 깊이를 줌. <키워드> 깊이감, 음영, 명암, 입체감.'],
    ['attractive male', 0, '[NAI V5 > 인물] 매력적인 남성을 표현함. <키워드> 이케멘, 미남, 미소년, 잘생긴 남자.'],
    ['low complexity', 5, '[NAI V5 > 복잡도] 이미지의 복잡도를 낮게 지정함. 스타일화된 이미지에 적합함. <키워드> 복잡도, 낮은 복잡도, 단순함. <연관태그> medium complexity, high complexity, ultra complexity.'],
    ['medium complexity', 5, '[NAI V5 > 복잡도] 이미지의 복잡도를 중간으로 지정함. <키워드> 복잡도, 중간 복잡도. <연관태그> low complexity, high complexity, ultra complexity.'],
    ['high complexity', 5, '[NAI V5 > 복잡도] 이미지의 복잡도를 높게 지정함. 일반적으로 보기 좋은 이미지에 적합함. <키워드> 복잡도, 높은 복잡도, 디테일. <연관태그> low complexity, medium complexity, ultra complexity.'],
    ['ultra complexity', 5, '[NAI V5 > 복잡도] 이미지의 복잡도를 매우 높게 지정함. 스타일화된 이미지에 적합함. <키워드> 복잡도, 최고 복잡도, 극세밀. <연관태그> low complexity, medium complexity, high complexity.'],
    ['has alpha', 5, '[NAI V5 > 투명도] 알파 채널을 활용하겠다는 선택적 태그. transparent background는 배경만 투명하게, alpha transparency는 장면 속 요소(마법 효과, 불, 우산 등)를 알파 투명하게 표현함. <키워드> 알파 채널, 투명, PNG. <연관태그> transparent background, alpha transparency.'],
    ['meta:novel era', 5, '[NAI V5 > 시대] 이미지가 덜 현대적인 느낌을 띠도록 미묘하게 편향함. <키워드> 시대, 노벨 시대, 레트로, 옛 그림체. <연관태그> meta:golden era.'],
    ['meta:golden era', 5, '[NAI V5 > 시대] 이미지가 약간 더 현대적인 느낌을 띠도록 미묘하게 편향함. <키워드> 시대, 황금기, 현대적, 최신 그림체. <연관태그> meta:novel era.'],
    ['visual novel art', 5, '[NAI V5 > 비주얼 노벨] 비주얼 노벨 일러스트 스타일임. <키워드> 비주얼 노벨, 미연시, 일러스트. <연관태그> visual novel bg, visual novel cg, visual novel chibi, visual novel sprite.'],
    ['visual novel bg', 5, '[NAI V5 > 비주얼 노벨] 비주얼 노벨의 배경 그림 스타일임. <키워드> 비주얼 노벨, 미연시, 배경. <연관태그> visual novel art, visual novel cg, visual novel chibi, visual novel sprite.'],
    ['visual novel chibi', 5, '[NAI V5 > 비주얼 노벨] 비주얼 노벨의 SD(치비) 캐릭터 스타일임. <키워드> 비주얼 노벨, 미연시, 치비, SD. <연관태그> visual novel art, visual novel bg, visual novel cg, visual novel sprite.'],
    ['visual novel sprite', 5, '[NAI V5 > 비주얼 노벨] 비주얼 노벨의 캐릭터 스탠딩 일러스트(스프라이트) 스타일임. <키워드> 비주얼 노벨, 미연시, 스탠딩, 스프라이트. <연관태그> visual novel art, visual novel bg, visual novel cg, visual novel chibi.'],
];

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

// Listed first so these count-less tags are not buried under popular Danbooru tags;
// the dataset entry wins if Danbooru later adopts the same name.
function loadImageTags(csv) {
    const tags = parseImageTags(csv);
    const names = new Set(tags.map(tag => tag.searchName));
    const novelAITags = NOVELAI_TAGS
        .filter(([name]) => !names.has(normalize(name)))
        .map(([name, category, description]) => ({ name, category, count: 0, description,
            searchName: normalize(name), searchDescription: normalize(description) }));
    return [...novelAITags, ...tags];
}

function searchImageTags(tags, query) {
    query = normalize(query);
    if (!query) return [];
    const matches = [[], [], [], []];
    for (const tag of tags) {
        const rank = tag.searchName === query ? 0
            : tag.searchName.startsWith(query) ? 1
            : tag.searchName.includes(query) ? 2
            : tag.searchDescription.includes(query) ? 3 : -1;
        if (rank >= 0 && matches[rank].length < SEARCH_LIMIT) {
            const { name, category, count, description } = tag;
            matches[rank].push({ name, category, count, description });
        }
    }
    return matches.flat().slice(0, SEARCH_LIMIT);
}

function validSource(source) {
    return source && /^[a-f0-9]{40}$/.test(source.revision)
        && TAG_CSV_NAME.test(source.filename)
        && (source.algorithm === 'sha256' ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{40}$/).test(source.checksum)
        && ['sha256', 'git-sha1'].includes(source.algorithm);
}

function selectImageTagSource(metadata) {
    const candidates = (metadata.siblings ?? [])
        .map(file => ({ file, match: TAG_CSV_NAME.exec(file.rfilename) }))
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
        if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new Error(`Image tag download failed: HTTP ${response.status}`);
        }
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
                tags = loadImageTags(bytes.toString('utf8'));
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
                    const filePath = latest.filename.split('/').map(encodeURIComponent).join('/');
                    const bytes = await fetchBytes(`${IMAGE_TAG_SOURCE.repository}/resolve/${latest.revision}/${filePath}`, MAX_CSV_BYTES, 90_000);
                    if (!validChecksum(bytes, latest)) throw new Error('Image tag CSV checksum mismatch');
                    const nextTags = loadImageTags(bytes.toString('utf8'));
                    await writeAtomic(csvPath(latest), bytes);
                    tags = nextTags;
                }
                cachedSource = latest;
                await writeAtomic(metadataPath, JSON.stringify({ schemaVersion: 1, checkedAt: lastCheckedAt, source: cachedSource }));
                // Sweep rather than delete the previous CSV: a cache from an older filename pattern
                // fails validation, so its CSV is never known as the previous source.
                const current = path.basename(csvPath(latest));
                const stale = (await fs.readdir(cacheDir)).filter(name => name.endsWith('.csv') && name !== current);
                await Promise.all(stale.map(name => fs.rm(path.join(cacheDir, name), { force: true })));
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

module.exports = { IMAGE_TAG_SOURCE, createImageTagService };
