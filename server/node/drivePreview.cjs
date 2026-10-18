'use strict';

const { getFileType } = require('../../shared/fileTypes.mjs');
const { getZip } = require('./zip.cjs');

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_CARD_JSON_BYTES = 1024 * 1024;
const ZIP_HEADER_ALLOWANCE = 128 * 1024;

async function readAt(fileHandle, fileSize, position, length) {
    if (!Number.isSafeInteger(position) || position < 0
        || !Number.isSafeInteger(length) || length < 0
        || position + length > fileSize) throw new Error('Invalid preview read');
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
        const { bytesRead } = await fileHandle.read(buffer, offset, length - offset, position + offset);
        if (!bytesRead) throw new Error('Truncated preview file');
        offset += bytesRead;
    }
    return buffer;
}

async function readCharxPreview(fileHandle, fileSize) {
    const zip = await getZip();
    const source = new zip.Reader();
    source.size = fileSize;
    let readBudget = MAX_ZIP_INDEX_BYTES + ZIP_HEADER_ALLOWANCE;
    source.readUint8Array = async (offset, length) => {
        if (length > readBudget) throw new Error('Preview read limit exceeded');
        readBudget -= length;
        return readAt(fileHandle, fileSize, offset, length);
    };
    const archive = new zip.ZipReader(source, { checkCrc32: true });
    try {
        const entries = new Map();
        for await (const entry of archive.getEntriesGenerator()) {
            if (entries.has(entry.filename)) return null;
            entries.set(entry.filename, entry);
        }
        async function readEntry(entry, maxBytes) {
            if (!entry || entry.directory || entry.encrypted
                || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize <= 0
                || entry.uncompressedSize > maxBytes
                || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0
                || entry.compressedSize > maxBytes + ZIP_HEADER_ALLOWANCE) return null;
            readBudget = entry.compressedSize + ZIP_HEADER_ALLOWANCE;
            const contents = Buffer.allocUnsafe(entry.uncompressedSize);
            let size = 0;
            await entry.getData(new WritableStream({
                write(chunk) {
                    size += chunk.length;
                    if (size > contents.length) throw new Error('Preview output limit exceeded');
                    contents.set(chunk, size - chunk.length);
                },
            }));
            if (size !== entry.uncompressedSize) return null;
            return contents;
        }
        const cardBytes = await readEntry(entries.get('card.json'), MAX_CARD_JSON_BYTES);
        if (!cardBytes) return null;
        const card = JSON.parse(cardBytes.toString('utf8'));
        if (card?.spec !== 'chara_card_v3' || !Array.isArray(card.data?.assets)) return null;
        const icon = card.data.assets.find(asset => asset?.type === 'icon' && asset?.name === 'main')
            ?? card.data.assets.find(asset => asset?.type === 'icon');
        if (typeof icon?.uri !== 'string' || !icon.uri.startsWith('embeded://')) return null;
        const memberName = icon.uri.slice('embeded://'.length);
        if (!memberName || memberName.startsWith('/') || memberName.startsWith('\\')
            || memberName.split(/[\\/]/).some(part => part === '..')
            || getFileType(memberName) !== 'image') return null;
        return await readEntry(entries.get(memberName), MAX_IMAGE_BYTES);
    } finally {
        await archive.close();
    }
}

async function readDrivePreview(fileHandle, filename, stat) {
    try {
        if (!stat || !Number.isSafeInteger(stat.size) || stat.size <= 0) return null;
        const type = getFileType(filename);
        if (type === 'image') {
            if (stat.size > MAX_IMAGE_BYTES) return null;
            return await readAt(fileHandle, stat.size, 0, stat.size);
        }
        if (type === 'character') return await readCharxPreview(fileHandle, stat.size);
        return null;
    } catch {
        // Invalid files and previews exceeding the read/output limits have no thumbnail.
        return null;
    }
}

module.exports = { readDrivePreview };
