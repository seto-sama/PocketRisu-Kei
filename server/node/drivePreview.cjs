'use strict';

const { inflateRaw } = require('node:zlib');
const { crc32 } = require('crc');
const { getFileType } = require('../../shared/fileTypes.mjs');

const MAX_IMAGE_BYTES = 50 * 1024 * 1024; // Caps source bytes and inflate output per preview.
const MAX_ZIP_INDEX_BYTES = 8 * 1024 * 1024; // Bounds central-directory memory.
const MAX_CARD_JSON_BYTES = 1 * 1024 * 1024; // Keeps card metadata parsing small.
const MAX_CARD_COMPRESSED_BYTES = MAX_CARD_JSON_BYTES + 64 * 1024;
const EOCD_SEARCH_BYTES = 22 + 0xffff; // ZIP permits a 65,535-byte archive comment.

function validSize(size) {
    return Number.isSafeInteger(size) && size >= 0;
}

async function readAt(fileHandle, fileSize, position, length) {
    if (!validSize(fileSize) || !Number.isSafeInteger(position) || position < 0
        || !Number.isSafeInteger(length) || length < 0
        || position + length > fileSize) return null;
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
        const { bytesRead } = await fileHandle.read(buffer, offset, length - offset, position + offset);
        if (bytesRead <= 0) return null;
        offset += bytesRead;
    }
    return buffer;
}

function inflateRawBounded(buffer, maxOutputLength) {
    return new Promise((resolve, reject) => {
        inflateRaw(buffer, { maxOutputLength }, (error, result) => {
            if (error) reject(error);
            else resolve(result);
        });
    });
}

function crcMatches(buffer, expected) {
    return (crc32(buffer) >>> 0) === expected;
}

function findEocd(tail) {
    for (let offset = tail.length - 22; offset >= 0; offset--) {
        if (tail.readUInt32LE(offset) !== 0x06054b50) continue;
        const commentLength = tail.readUInt16LE(offset + 20);
        if (offset + 22 + commentLength === tail.length) return offset;
    }
    return -1;
}

function parseCentralDirectory(buffer, expectedEntries) {
    const entries = new Map();
    const duplicates = new Set();
    let offset = 0;
    for (let index = 0; index < expectedEntries; index++) {
        if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) return null;
        const flags = buffer.readUInt16LE(offset + 8);
        const method = buffer.readUInt16LE(offset + 10);
        const crc = buffer.readUInt32LE(offset + 16);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const uncompressedSize = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const diskNumber = buffer.readUInt16LE(offset + 34);
        const localHeaderOffset = buffer.readUInt32LE(offset + 42);
        const end = offset + 46 + nameLength + extraLength + commentLength;
        if (end > buffer.length || diskNumber !== 0
            || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
            || localHeaderOffset === 0xffffffff) return null;

        const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength);
        const name = rawName.toString('utf8');
        const entry = { name, rawName: Buffer.from(rawName), flags, method, crc, compressedSize, uncompressedSize, localHeaderOffset };
        if (entries.has(name)) duplicates.add(name);
        else entries.set(name, entry);
        offset = end;
    }
    if (offset !== buffer.length) return null;
    return { entries, duplicates };
}

async function readZipEntry(fileHandle, fileSize, entry, prefixOffset, centralDirectoryStart, maxBytes, maxCompressedBytes) {
    if (!entry || (entry.flags & 0x2041) !== 0 || entry.uncompressedSize <= 0
        || entry.uncompressedSize > maxBytes || entry.compressedSize > maxCompressedBytes
        || (entry.method !== 0 && entry.method !== 8)) return null;

    const localHeaderPosition = entry.localHeaderOffset + prefixOffset;
    if (!Number.isSafeInteger(localHeaderPosition) || localHeaderPosition < prefixOffset
        || localHeaderPosition + 30 > centralDirectoryStart) return null;
    const localHeader = await readAt(fileHandle, fileSize, localHeaderPosition, 30);
    if (!localHeader || localHeader.readUInt32LE(0) !== 0x04034b50) return null;
    const localFlags = localHeader.readUInt16LE(6);
    if ((localFlags & 0x2041) !== 0 || localHeader.readUInt16LE(8) !== entry.method) return null;
    const localNameLength = localHeader.readUInt16LE(26);
    const localExtraLength = localHeader.readUInt16LE(28);
    const localNamePosition = localHeaderPosition + 30;
    const dataPosition = localNamePosition + localNameLength + localExtraLength;
    const dataEnd = dataPosition + entry.compressedSize;
    if (dataEnd > centralDirectoryStart || dataEnd > fileSize) return null;
    const localName = await readAt(fileHandle, fileSize, localNamePosition, localNameLength);
    if (!localName || !localName.equals(entry.rawName)) return null;
    const compressed = await readAt(fileHandle, fileSize, dataPosition, entry.compressedSize);
    if (!compressed) return null;

    let contents;
    if (entry.method === 0) {
        if (entry.compressedSize !== entry.uncompressedSize) return null;
        contents = compressed;
    } else {
        contents = await inflateRawBounded(compressed, maxBytes);
        if (contents.length !== entry.uncompressedSize) return null;
    }
    return crcMatches(contents, entry.crc) ? contents : null;
}

async function readCharxPreview(fileHandle, fileSize) {
    if (!validSize(fileSize) || fileSize < 22) return null;
    const tailLength = Math.min(fileSize, EOCD_SEARCH_BYTES);
    const tailStart = fileSize - tailLength;
    const tail = await readAt(fileHandle, fileSize, tailStart, tailLength);
    if (!tail) return null;
    const eocdOffsetInTail = findEocd(tail);
    if (eocdOffsetInTail < 0) return null;

    const eocdPosition = tailStart + eocdOffsetInTail;
    const eocd = tail.subarray(eocdOffsetInTail, eocdOffsetInTail + 22);
    const diskNumber = eocd.readUInt16LE(4);
    const centralDisk = eocd.readUInt16LE(6);
    const entriesOnDisk = eocd.readUInt16LE(8);
    const entryCount = eocd.readUInt16LE(10);
    const centralSize = eocd.readUInt32LE(12);
    const centralOffset = eocd.readUInt32LE(16);
    if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount
        || entryCount === 0 || entryCount === 0xffff
        || centralSize === 0xffffffff || centralOffset === 0xffffffff
        || centralSize === 0 || centralSize > MAX_ZIP_INDEX_BYTES) return null;

    // CharX archives place the central directory immediately before EOCD; the difference handles SFX prefixes.
    const centralDirectoryStart = eocdPosition - centralSize;
    const prefixOffset = centralDirectoryStart - centralOffset;
    if (centralDirectoryStart < 0 || prefixOffset < 0) return null;
    const centralDirectory = await readAt(fileHandle, fileSize, centralDirectoryStart, centralSize);
    if (!centralDirectory) return null;
    const parsed = parseCentralDirectory(centralDirectory, entryCount);
    if (!parsed || parsed.duplicates.has('card.json')) return null;
    const cardEntry = parsed.entries.get('card.json');
    if (!cardEntry || cardEntry.uncompressedSize > MAX_CARD_JSON_BYTES
        || cardEntry.compressedSize > MAX_CARD_COMPRESSED_BYTES) return null;
    const cardBytes = await readZipEntry(
        fileHandle, fileSize, cardEntry, prefixOffset, centralDirectoryStart,
        MAX_CARD_JSON_BYTES, MAX_CARD_COMPRESSED_BYTES,
    );
    if (!cardBytes) return null;

    let card;
    try { card = JSON.parse(cardBytes.toString('utf8')); } catch { return null; }
    if (card?.spec !== 'chara_card_v3' || !Array.isArray(card.data?.assets)) return null;
    const assets = card.data.assets;
    const icon = assets.find(asset => asset?.type === 'icon' && asset?.name === 'main')
        ?? assets.find(asset => asset?.type === 'icon');
    if (typeof icon?.uri !== 'string' || !icon.uri.startsWith('embeded://')) return null;
    const memberName = icon.uri.slice('embeded://'.length);
    if (!memberName || memberName.startsWith('/') || memberName.startsWith('\\')
        || memberName.split(/[\\/]/).some(part => part === '..')
        || getFileType(memberName) !== 'image' || parsed.duplicates.has(memberName)) return null;

    const imageEntry = parsed.entries.get(memberName);
    if (!imageEntry) return null;
    return readZipEntry(
        fileHandle, fileSize, imageEntry, prefixOffset, centralDirectoryStart,
        MAX_IMAGE_BYTES, MAX_IMAGE_BYTES,
    );
}

async function readDrivePreview(fileHandle, filename, stat) {
    try {
        if (!stat || !validSize(stat.size) || stat.size === 0) return null;
        const type = getFileType(filename);
        if (type === 'image') {
            if (stat.size > MAX_IMAGE_BYTES) return null;
            return readAt(fileHandle, stat.size, 0, stat.size);
        }
        if (type === 'character') return await readCharxPreview(fileHandle, stat.size);
        return null;
    } catch {
        // Preview parsing is best-effort; malformed or resource-heavy files stay unavailable.
        return null;
    }
}

module.exports = { readDrivePreview };
