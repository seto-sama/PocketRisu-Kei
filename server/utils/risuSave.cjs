const { Packr, Unpackr, decode } = require('msgpackr');
const { createGzip, gunzip, inflate, inflateRaw } = require('node:zlib');
const { promisify } = require('node:util');
const { ensureDatabasePresetIds } = require('../../shared/entityIds.mjs');
const { logger } = require('../logs/logs.cjs');
const { apiErrorMessage, codes } = require('./apiErrors.cjs');

// Magic headers for different save formats
const magicHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]);
const magicCompressedHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8]);
const magicStreamCompressedHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 9]);
const magicRisuSaveHeader = new TextEncoder().encode("RISUSAVE\0");

// Save type enums (must match client-side RisuSaveType)
const RisuSaveType = {
    CONFIG: 0,
    ROOT: 1,
    CHARACTER_WITH_CHAT: 2,
    CHAT: 3,
    BOTPRESET: 4,
    MODULES: 5,
    UNSUPPORTED_REMOTE: 6,
    CHARACTER_WITHOUT_CHAT: 7,
    ROOT_COMPONENT: 8,
    PLUGINS: 9,
    LOADOUTS: 10,
    PLUGIN_STORAGE: 11,
};

// Packr/Unpackr instances
const packr = new Packr({
    useRecords: false
});

const unpackr = new Unpackr({
    int64AsType: 'number',
    useRecords: false
});

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const inflateRawAsync = promisify(inflateRaw);

async function decompressBuffer(input) {
    const isGzip = input[0] === 0x1f && input[1] === 0x8b && input[2] === 0x08;
    const isZlib = input.length >= 2
        && (input[0] & 0x0f) === 8 && (input[0] >> 4) <= 7
        && ((input[0] << 8) | input[1]) % 31 === 0;
    const decompress = isGzip ? gunzipAsync : isZlib ? inflateAsync : inflateRawAsync;
    return decompress(input);
}

/**
 * Check the header type of saved data
 * @param {Uint8Array} data - The data to check
 * @returns {string|false} - The header type
 */
function checkHeader(data) {
    let header = 'raw';

    if (data.length < magicHeader.length) {
        return false;
    }

    for (let i = 0; i < magicHeader.length; i++) {
        if (data[i] !== magicHeader[i]) {
            header = 'none';
            break;
        }
    }

    if (header === 'none') {
        header = 'compressed';
        for (let i = 0; i < magicCompressedHeader.length; i++) {
            if (data[i] !== magicCompressedHeader[i]) {
                header = 'none';
                break;
            }
        }
    }

    if (header === 'none') {
        header = 'stream';
        for (let i = 0; i < magicStreamCompressedHeader.length; i++) {
            if (data[i] !== magicStreamCompressedHeader[i]) {
                header = 'none';
                break;
            }
        }
    }

    if (header === 'none') {
        header = 'risusave';
        for (let i = 0; i < magicRisuSaveHeader.length; i++) {
            if (data[i] !== magicRisuSaveHeader[i]) {
                header = 'none';
                break;
            }
        }
    }

    return header;
}

/**
 * RisuSave decoder class for server-side decoding
 */
class RisuSaveDecoder {
    constructor() {
        this.blocks = [];
    }

    async decode(data) {
        let offset = magicRisuSaveHeader.length;
        let db = {};

        while (offset < data.length) {
            try {
                const type = data[offset];
                const compression = data[offset + 1] === 1;
                offset += 2;

                const nameLength = data[offset];
                offset += 1;
                const name = new TextDecoder().decode(data.subarray(offset, offset + nameLength));
                offset += nameLength;

                const newArrayBuf = new ArrayBuffer(4);
                const lengthSubUint8Buf = data.slice(offset, offset + 4);
                new Uint8Array(newArrayBuf).set(lengthSubUint8Buf);
                const length = new Uint32Array(newArrayBuf)[0];
                offset += 4;

                let blockData = data.subarray(offset, offset + length);
                offset += length;

                if (compression) {
                    const cs = new DecompressionStream('gzip');
                    const writer = cs.writable.getWriter();
                    writer.write(blockData);
                    writer.close();
                    const buf = await new Response(cs.readable).arrayBuffer();
                    blockData = new Uint8Array(buf);
                }

                this.blocks.push({
                    name,
                    type,
                    compression,
                    content: new TextDecoder().decode(blockData)
                });
            } catch (error) {
                continue;
            }
        }

        if (this.blocks.some(block => block.type === RisuSaveType.UNSUPPORTED_REMOTE)) {
            const error = new Error(apiErrorMessage(codes.UNSUPPORTED_REMOTE_SAVE));
            error.code = codes.UNSUPPORTED_REMOTE_SAVE;
            throw error;
        }

        for (let i = 0; i < this.blocks.length; i++) {
            const key = i;
            try {
                switch (this.blocks[key].type) {
                    case RisuSaveType.ROOT: {
                        const rootData = JSON.parse(this.blocks[key].content);
                        for (const rootKey in rootData) {
                            if (!db[rootKey] && !rootKey.startsWith('__')) {
                                db[rootKey] = rootData[rootKey];
                            }
                        }
                        break;
                    }
                    case RisuSaveType.CHARACTER_WITH_CHAT:
                    case RisuSaveType.CHARACTER_WITHOUT_CHAT: {
                        db.characters ??= [];
                        const character = JSON.parse(this.blocks[key].content);
                        db.characters.push(character);
                        break;
                    }
                    case RisuSaveType.BOTPRESET: {
                        db.botPresets = JSON.parse(this.blocks[key].content);
                        break;
                    }
                    case RisuSaveType.MODULES: {
                        db.modules = JSON.parse(this.blocks[key].content);
                        break;
                    }
                    case RisuSaveType.PLUGINS: {
                        db.plugins = JSON.parse(this.blocks[key].content);
                        break;
                    }
                    case RisuSaveType.LOADOUTS: {
                        db.loadouts = JSON.parse(this.blocks[key].content);
                        break;
                    }
                    case RisuSaveType.PLUGIN_STORAGE: {
                        db.pluginCustomStorage = JSON.parse(this.blocks[key].content);
                        break;
                    }
                    case RisuSaveType.ROOT_COMPONENT: {
                        const componentData = JSON.parse(this.blocks[key].content);
                        db[componentData.key] = componentData.data;
                        break;
                    }
                    default: {
                        // Not implemented type, skip
                    }
                }
            } catch (error) {
                logger.error(`[RisuSaveDecoder] Error processing block ${this.blocks[key].name}:`, error);
                if (this.blocks[key].type === RisuSaveType.ROOT) {
                    throw new Error('Failed to decode root block, cannot proceed with decoding RisuSave data');
                }
            }
        }
        if(!Array.isArray(db.characters)){
            db.characters = [];
        }
        if (!Array.isArray(db.botPresets) || db.botPresets.length === 0) {
            delete db.botPresets;
            db.botPresetsId = 0;
        }
        return db;
    }
}

/**
 * Decode RisuSave data
 * @param {Uint8Array} data - The data to decode
 * @returns {Promise<Object>} - The decoded database
 */
async function decodeRisuSave(data) {
    const result = await _decodeRisuSaveInternal(data);
    return ensureDatabasePresetIds(result);
}

async function _decodeRisuSaveInternal(data) {
    try {
        const header = checkHeader(data);
        switch (header) {
            case "compressed":
                data = data.slice(magicCompressedHeader.length);
                return decode(await decompressBuffer(data));
            case "raw":
                data = data.slice(magicHeader.length);
                return unpackr.decode(data);
            case "stream": {
                data = data.slice(magicStreamCompressedHeader.length);
                return unpackr.decode(await gunzipAsync(Buffer.from(data)));
            }
            case "risusave": {
                const decoder = new RisuSaveDecoder();
                return await decoder.decode(data);
            }
        }
        return unpackr.decode(data);
    } catch (error) {
        if (error?.code === codes.UNSUPPORTED_REMOTE_SAVE) throw error;
        logger.error('Error decoding RisuSave data:', error);
        try {
            const risuSaveHeader = new Uint8Array(Buffer.from("\u0000\u0000RISU", 'utf-8'));
            const realData = data.subarray(risuSaveHeader.length);
            const dec = unpackr.decode(realData);
            return dec;
        } catch (error) {
            const buf = await decompressBuffer(data);
            try {
                return JSON.parse(buf.toString('utf-8'));
            } catch (error) {
                return unpackr.decode(buf);
            }
        }
    }
}

async function encodeRisuSave(data, onProgress) {
    const input = packr.encode(data);
    const compressor = createGzip();
    let compressedBytes = magicCompressedHeader.length;
    let encoded;
    try {
        const [, chunks] = await Promise.all([
            (async () => {
                onProgress?.(0, input.length, compressedBytes);
                const chunkSize = 256 * 1024;
                for (let offset = 0; offset < input.length; offset += chunkSize) {
                    const end = Math.min(offset + chunkSize, input.length);
                    await new Promise((resolve, reject) => {
                        compressor.write(input.subarray(offset, end), (error) => error ? reject(error) : resolve());
                    });
                    if (end < input.length) onProgress?.(end, input.length, compressedBytes);
                }
                compressor.end();
            })(),
            Array.fromAsync(compressor, (chunk) => {
                compressedBytes += chunk.length;
                return chunk;
            }),
        ]);
        encoded = Buffer.concat([Buffer.from(magicCompressedHeader), ...chunks], compressedBytes);
        onProgress?.(input.length, input.length, compressedBytes);
    } finally {
        compressor.destroy();
    }
    return encoded;
}

function encodeRisuSaveLegacy(data) {
    const encoded = packr.encode(data);
    const result = new Uint8Array(encoded.length + magicHeader.length);
    result.set(magicHeader, 0);
    result.set(encoded, magicHeader.length);
    return result;
}

module.exports = {
    decodeRisuSave,
    decompressBuffer,
    encodeRisuSave,
    encodeRisuSaveLegacy,
};
