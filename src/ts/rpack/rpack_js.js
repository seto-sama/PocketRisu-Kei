import fileBufferUrl from '../../../server/shared/rpack_map.bin?url';

let encodeMap;
let decodeMap;
let initPromise;

export function initRPack() {
    if (!initPromise) {
        initPromise = (async () => {
            const response = await fetch(fileBufferUrl);
            const mapData = new Uint8Array(await response.arrayBuffer());
            encodeMap = mapData.subarray(0, 256);
            decodeMap = mapData.subarray(256, 512);
        })().catch(error => {
            initPromise = undefined;
            throw error;
        });
    }
    return initPromise;
}

export async function encodeRPack(data) {
    await initRPack();
    let result = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
        result[i] = encodeMap[data[i]];
    }
    return result;
}
export async function decodeRPack(data) {
    await initRPack();
    let result = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
        result[i] = decodeMap[data[i]];
    }
    return result;
}
