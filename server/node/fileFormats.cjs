'use strict';

const { createCipheriv, createDecipheriv, createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { gzip } = require('node:zlib');
const { promisify } = require('node:util');
const { decode, encode } = require('msgpackr');
const { decodeRisuSave, encodeRisuSave, decompressBuffer } = require('./utils/risuSave.cjs');
const {
    exportPromptPresetSelection,
    importPromptPresetSelection,
} = require('../../shared/promptPresetSelection.mjs');

const gzipAsync = promisify(gzip);
const rpackMapPath = path.resolve(__dirname, '../shared/rpack_map.bin');
let rpackMaps;

const presetFormats = {
    preset: {
        versionKey: 'presetVersion',
        version: 2,
        acceptedVersions: [0, 2],
        type: 'preset',
        password: 'risupreset',
        valueKey: 'preset',
        legacyValueKey: 'pres',
    },
    theme: {
        versionKey: 'presetVersion',
        version: 1,
        acceptedVersions: [1],
        type: 'theme',
        password: 'risutheme',
        valueKey: 'preset',
    },
    translator: {
        versionKey: 'translatorPresetVersion',
        version: 1,
        acceptedVersions: [1],
        type: 'translator-preset',
        password: 'risutl',
        valueKey: 'preset',
    },
};

function getRPackMaps() {
    if (!rpackMaps) {
        const map = readFileSync(rpackMapPath);
        if (map.length !== 512) throw new Error('Invalid RPack substitution map');
        rpackMaps = [map.subarray(0, 256), map.subarray(256, 512)];
    }
    return rpackMaps;
}

function transformRPack(data, mapIndex) {
    const input = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const map = getRPackMaps()[mapIndex];
    const output = Buffer.allocUnsafe(input.length);
    for (let index = 0; index < input.length; index++) output[index] = map[input[index]];
    return output;
}

function toBuffer(data) {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return undefined;
}

function encrypt(data, password) {
    const key = createHash('sha256').update(password, 'utf8').digest();
    const cipher = createCipheriv('aes-256-gcm', key, Buffer.alloc(12));
    return Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
}

function decrypt(data, password) {
    const input = toBuffer(data);
    if (!input || input.length < 16) throw new Error('Invalid encrypted preset data');
    const key = createHash('sha256').update(password, 'utf8').digest();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.alloc(12));
    decipher.setAuthTag(input.subarray(input.length - 16));
    return Buffer.concat([decipher.update(input.subarray(0, -16)), decipher.final()]);
}

async function decodeCompressedContainer(data) {
    let lastError;
    for (const candidate of [data, transformRPack(data, 1)]) {
        try {
            return decode(await decompressBuffer(candidate));
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}

async function encodeFile(format, value) {
    if (format === 'json') return Buffer.from(JSON.stringify(value, null, 2), 'utf8');
    if (format === 'save') return encodeRisuSave(exportPromptPresetSelection(value));
    const config = Object.hasOwn(presetFormats, format) ? presetFormats[format] : undefined;
    if (!config) throw new Error(`Unsupported file format: ${format}`);

    const envelope = {
        [config.versionKey]: config.version,
        type: config.type,
        [config.valueKey]: encrypt(encode(value), config.password),
    };
    return transformRPack(await gzipAsync(encode(envelope)), 0);
}

async function decodeFile(format, data) {
    if (format === 'json') return JSON.parse(Buffer.from(data).toString('utf8'));
    if (format === 'save') {
        return importPromptPresetSelection(await decodeRisuSave(data));
    }
    const config = Object.hasOwn(presetFormats, format) ? presetFormats[format] : undefined;
    if (!config) throw new Error(`Unsupported file format: ${format}`);

    const envelope = await decodeCompressedContainer(data);
    if (!envelope || envelope.type !== config.type
        || !config.acceptedVersions.includes(envelope[config.versionKey])) {
        throw new Error(`Invalid ${format} file`);
    }

    const encrypted = envelope[config.valueKey] ?? envelope[config.legacyValueKey];
    if (!toBuffer(encrypted)) {
        throw new Error(`Invalid ${format} file`);
    }
    return decode(decrypt(encrypted, config.password));
}

module.exports = { encodeFile, decodeFile };
