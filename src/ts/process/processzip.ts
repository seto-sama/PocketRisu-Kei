import { AppendableBuffer, saveAsset, type LocalWriter, type VirtualWriter } from "../globalApi.svelte";
import { zip } from "./zip";
import { asBuffer, Semaphore } from "../util";
import { alertStore } from "../alert";

const MAX_ASSET_SIZE_BYTES = 50 * 1024 * 1024;
const MAX_CONCURRENT_ASSET_SAVES = 10;
const ASSET_BYTES_PER_SAVE_SLOT = MAX_ASSET_SIZE_BYTES / MAX_CONCURRENT_ASSET_SAVES;

export class CharXWriter {
    private zip: zip.ZipWriter<unknown>;
    #takenFilenames = new Set<string>();

    constructor(private writer: LocalWriter | WritableStreamDefaultWriter<Uint8Array> | VirtualWriter) {
        const output = new WritableStream<Uint8Array>({
            write: data => this.writer.write(data),
            close: () => this.writer.close(),
        });
        this.zip = new zip.ZipWriter(output);
    }

    async init() {}

    async writeJpeg(img: Uint8Array) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const imgURL = URL.createObjectURL(new Blob([asBuffer(img)], { type: 'image/jpeg' }));
        try {
            const imgElement = document.createElement('img');
            imgElement.src = imgURL;
            await imgElement.decode();
            canvas.width = imgElement.width;
            canvas.height = imgElement.height;
            ctx.drawImage(imgElement, 0, 0);

            const blob = await new Promise<Blob>((resolve, reject) => {
                canvas.toBlob(result => result ? resolve(result) : reject(new Error('JPEG encoding failed')), 'image/jpeg');
            });
            await this.writer.write(new Uint8Array(await blob.arrayBuffer()));
        } finally {
            URL.revokeObjectURL(imgURL);
        }
    }

    async write(key: string, data: Uint8Array | string, level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9) {
        const filename = this.#sanitizeZipFilename(key);
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        await this.zip.add(filename, new zip.Uint8ArrayReader(bytes), {
            compressionMethod: 8,
            level: level ?? 0,
        });
    }

    #sanitizeZipFilename(filename: string) {
        let sanitized = filename.replace(/[<>:"\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/, '');
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(sanitized)) sanitized = `_${sanitized}`;
        if (!sanitized || sanitized === '.' || sanitized === '..') sanitized = `file_${Date.now()}`;

        const splitName = sanitized.split('.');
        const extension = splitName.length > 1 ? `.${splitName.pop()}` : '';
        const baseName = splitName.join('.');
        let uniqueName = baseName + extension;
        for (let counter = 1; this.#takenFilenames.has(uniqueName); counter++) {
            uniqueName = `${baseName}_${counter}${extension}`;
        }
        this.#takenFilenames.add(uniqueName);
        return uniqueName;
    }

    async end() {
        await this.zip.close();
    }
}

export class CharXImporter {
    private semaphore = new Semaphore(MAX_CONCURRENT_ASSET_SAVES);
    private pendingSaves = new Set<Promise<void>>();
    private totalEnqueued = 0;
    private totalCompleted = 0;
    private parseComplete = false;
    private errors: Error[] = [];

    assets: { [key: string]: string } = {};
    cardData: string | undefined;
    moduleData: Uint8Array | undefined;
    alertInfo = false;

    async parse(data: Uint8Array | File | ReadableStream<Uint8Array>) {
        await Promise.all(this.pendingSaves);
        this.pendingSaves.clear();
        this.totalEnqueued = 0;
        this.totalCompleted = 0;
        this.parseComplete = false;
        this.errors = [];
        const reader = data instanceof File
            ? new zip.BlobReader(data)
            : data instanceof Uint8Array
                ? new zip.Uint8ArrayReader(data)
                : data;
        const archive = new zip.ZipReader(reader);
        try {
            try {
                await this.#readEntries(archive.getEntriesGenerator());
            } finally {
                await archive.close().catch(() => {});
            }
        } catch (error) {
            this.errors.push(error instanceof Error ? error : new Error(String(error)));
            await Promise.all(this.pendingSaves);
            throw error;
        } finally {
            this.parseComplete = true;
        }
    }

    async done() {
        if (!this.parseComplete) throw new Error('parse() must finish before done()');
        await Promise.all(this.pendingSaves);
        if (this.errors.length === 1) throw this.errors[0];
        else if (this.errors.length > 1) throw new AggregateError(this.errors, `Failed to save ${this.errors.length} assets`);
    }

    async #readEntries(entries: AsyncIterable<zip.Entry>) {
        for await (const entry of entries) {
            if (!('getData' in entry)) continue;
            if (entry.filename.endsWith('.json') && entry.filename !== 'card.json') continue;
            const declaredSize = entry.uncompressedSize;
            const validDeclaredSize = typeof declaredSize === 'number' && Number.isSafeInteger(declaredSize) && declaredSize >= 0
                ? declaredSize
                : undefined;
            if (validDeclaredSize !== undefined && validDeclaredSize > MAX_ASSET_SIZE_BYTES) {
                continue;
            }
            const entrySizeLimit = validDeclaredSize ?? MAX_ASSET_SIZE_BYTES;

            const isAsset = entry.filename !== 'card.json' && entry.filename !== 'module.risum' && !entry.filename.endsWith('.json');
            const saveSlots = isAsset
                ? Math.max(1, Math.ceil(entrySizeLimit / ASSET_BYTES_PER_SAVE_SLOT))
                : 0;
            for (let slot = 0; slot < saveSlots; slot++) await this.semaphore.acquire();
            let releaseSlots = saveSlots;
            try {
                const fixedBuffer = validDeclaredSize === undefined ? undefined : new Uint8Array(validDeclaredSize);
                const appendableBuffer = new AppendableBuffer();
                let length = 0;
                let oversized = false;
                try {
                    await entry.getData(new WritableStream<Uint8Array>({
                        write: chunk => {
                            if (length + chunk.byteLength > entrySizeLimit) {
                                oversized = true;
                                throw new Error('ZIP entry exceeds its size limit');
                            }
                            if (fixedBuffer) fixedBuffer.set(chunk, length);
                            else appendableBuffer.append(chunk);
                            length += chunk.byteLength;
                        },
                    }));
                } catch (error) {
                    if (!oversized || (validDeclaredSize !== undefined && entrySizeLimit < MAX_ASSET_SIZE_BYTES)) throw error;
                }
                if (oversized) continue;
                if (validDeclaredSize !== undefined && length !== validDeclaredSize) {
                    throw new Error(`ZIP entry size mismatch for ${entry.filename}`);
                }
                const entryData = fixedBuffer ?? appendableBuffer.buffer;
                if (entry.filename === 'card.json') {
                    this.cardData = new TextDecoder().decode(entryData);
                } else if (entry.filename === 'module.risum') {
                    this.moduleData = entryData;
                } else if (isAsset) {
                    releaseSlots = 0;
                    this.#queueAsset({ id: entry.filename, data: entryData }, saveSlots);
                }
            } finally {
                for (let slot = 0; slot < releaseSlots; slot++) this.semaphore.release();
            }
        }
    }

    #queueAsset(asset: { id: string, data: Uint8Array }, saveSlots: number) {
        this.totalEnqueued++;
        let save: Promise<void>;
        save = this.#processAssetQueue(asset, saveSlots)
            .catch(error => {
                this.errors.push(error instanceof Error ? error : new Error(String(error)));
            })
            .finally(() => this.pendingSaves.delete(save));
        this.pendingSaves.add(save);
    }

    async #processAssetQueue(asset: { id: string, data: Uint8Array }, saveSlots: number) {
        try {
            const assetSaveId = await saveAsset(asset.data);
            this.assets[asset.id] = assetSaveId;
        } finally {
            for (let slot = 0; slot < saveSlots; slot++) this.semaphore.release();
            this.totalCompleted++;
            if (this.alertInfo) {
                alertStore.set({ type: 'wait', msg: `Loading... (Saving Assets ${this.totalCompleted}/${this.totalEnqueued})` });
            }
        }
    }
}
