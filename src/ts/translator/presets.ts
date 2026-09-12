import { decode as decodeMsgpack, encode as encodeMsgpack } from "msgpackr/index-no-eval";
import * as fflate from "fflate";
import { decryptBuffer, encryptBuffer } from "src/ts/util";
import { decodeRPack, encodeRPack } from "src/ts/rpack/rpack_js.js";
import { createEntityId } from 'src/ts/id';
import { normalizePresetTagFields, type PresetTagFields } from "src/ts/preset/tags";

export interface TranslatorPreset extends PresetTagFields {
    id: string;
    name: string;
    prompt: string;
    maxResponse: number;
}

export interface TranslatorPresetStateLike {
    translatorPrompt?: string;
    translatorMaxResponse?: number;
    translatorPresets?: unknown[];
    translatorPresetId?: number;
    translatorPresetTags?: { id: string; name: string }[];
}

interface EncryptedTranslatorPresetFile {
    translatorPresetVersion: 1;
    type: "translator-preset";
    preset: Uint8Array | ArrayBuffer;
}

export const defaultTranslatorPrompt =
    "You are a translator. translate the following html or text into {{slot}}. do not output anything other than the translation.";
export const translatorPresetFileExtension = "risutl";
export const translatorPresetImportExtensions = [translatorPresetFileExtension];
const translatorPresetEncryptionKey = "risutl";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

type TranslatorPresetInput = Omit<TranslatorPreset, "id"> & {
    id?: string;
    folderId?: string | string[];
};

function isTranslatorPresetInput(value: unknown): value is TranslatorPresetInput {
    return (
        isRecord(value) &&
        (value.id === undefined || typeof value.id === "string") &&
        typeof value.name === "string" &&
        typeof value.prompt === "string" &&
        typeof value.maxResponse === "number" &&
        Number.isFinite(value.maxResponse) &&
        (value.tagIds === undefined || (
            Array.isArray(value.tagIds) && value.tagIds.every(id => typeof id === "string")
        )) &&
        (value.folderId === undefined || typeof value.folderId === "string" || (
            Array.isArray(value.folderId) && value.folderId.every(id => typeof id === "string")
        ))
    );
}

function getBytes(value: unknown): Uint8Array | null {
    if (value instanceof Uint8Array) {
        return value;
    }

    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }

    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }

    return null;
}

function isEncryptedTranslatorPresetFile(value: unknown): value is EncryptedTranslatorPresetFile {
    return (
        isRecord(value) &&
        value.translatorPresetVersion === 1 &&
        value.type === "translator-preset" &&
        getBytes(value.preset) !== null
    );
}

function getDefaultTranslatorPreset(state: TranslatorPresetStateLike): TranslatorPreset {
    return createTranslatorPreset("Default", {
        prompt: state.translatorPrompt ?? "",
        maxResponse: state.translatorMaxResponse ?? 1000,
    });
}

function getNormalizedTranslatorPresetName(name: unknown, index: number): string {
    if (typeof name === "string" && name.trim().length > 0) {
        return name;
    }

    return `Preset ${index + 1}`;
}

function sanitizeFileNamePart(value: string): string {
    const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
    return sanitized.length > 0 ? sanitized : "preset";
}

export function createTranslatorPreset(
    name = "New Preset",
    existing: Partial<TranslatorPreset> & { folderId?: unknown } = {}
): TranslatorPreset {
    return normalizePresetTagFields({
        id: typeof existing.id === "string" && existing.id.length > 0 ? existing.id : createEntityId(),
        name,
        prompt: typeof existing.prompt === "string" ? existing.prompt : "",
        maxResponse:
            typeof existing.maxResponse === "number" && Number.isFinite(existing.maxResponse)
                ? existing.maxResponse
                : 1000,
        tagIds: existing.tagIds,
        folderId: existing.folderId,
    });
}

type TranslatorPresetCollection = {
    translatorPresets: TranslatorPreset[];
    translatorPresetId: number;
    translatorPrompt?: string;
    translatorMaxResponse?: number;
};

export function appendTranslatorPreset(
    state: TranslatorPresetCollection,
    preset: TranslatorPreset,
): number {
    state.translatorPresets = [...state.translatorPresets, preset];
    state.translatorPresetId = state.translatorPresets.length - 1;
    syncCurrentTranslatorPresetToLegacyFields(state);
    return state.translatorPresetId;
}

export function duplicateTranslatorPreset(
    state: TranslatorPresetCollection,
    index: number,
    copyLabel: string,
): TranslatorPreset | undefined {
    const source = state.translatorPresets[index];
    if (!source) return undefined;
    const preset = createTranslatorPreset(`${source.name} ${copyLabel}`, {
        ...source,
        id: undefined,
    });
    appendTranslatorPreset(state, preset);
    return preset;
}

export function moveTranslatorPreset(
    state: TranslatorPresetCollection,
    fromIndex: number,
    toIndex: number,
): boolean {
    const presets = state.translatorPresets;
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= presets.length || toIndex > presets.length) return false;
    const selectedId = presets[state.translatorPresetId]?.id;
    const next = [...presets];
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) return false;
    next.splice(fromIndex < toIndex ? toIndex - 1 : toIndex, 0, moved);
    state.translatorPresets = next;
    state.translatorPresetId = Math.max(0, next.findIndex(preset => preset.id === selectedId));
    syncCurrentTranslatorPresetToLegacyFields(state);
    return true;
}

export function removeTranslatorPreset(
    state: TranslatorPresetCollection,
    index: number,
): boolean {
    const presets = state.translatorPresets;
    if (presets.length <= 1 || !presets[index]) return false;
    const selectedId = presets[state.translatorPresetId]?.id;
    state.translatorPresets = presets.filter((_, presetIndex) => presetIndex !== index);
    const selectedIndex = state.translatorPresets.findIndex(preset => preset.id === selectedId);
    state.translatorPresetId = selectedIndex >= 0
        ? selectedIndex
        : Math.min(index, state.translatorPresets.length - 1);
    syncCurrentTranslatorPresetToLegacyFields(state);
    return true;
}

export function normalizeTranslatorPresetState<T extends TranslatorPresetStateLike>(state: T): T {
    const defaultPreset = getDefaultTranslatorPreset(state);
    const sourcePresets =
        Array.isArray(state.translatorPresets) && state.translatorPresets.length > 0
            ? state.translatorPresets
            : [defaultPreset];

    state.translatorPresets = sourcePresets.map((preset, index) => {
        const normalizedPreset = isRecord(preset) ? preset : {};
        return createTranslatorPreset(
            getNormalizedTranslatorPresetName(normalizedPreset.name, index),
            normalizedPreset
        );
    });

    const requestedId =
        typeof state.translatorPresetId === "number" && Number.isInteger(state.translatorPresetId)
            ? state.translatorPresetId
            : 0;

    state.translatorPresetId = Math.min(
        Math.max(requestedId, 0),
        Math.max(state.translatorPresets.length - 1, 0)
    );

    return syncCurrentTranslatorPresetToLegacyFields(state);
}

export function syncCurrentTranslatorPresetToLegacyFields<T extends TranslatorPresetStateLike>(
    state: T
): T {
    const preset = state.translatorPresets?.[state.translatorPresetId ?? 0] as TranslatorPreset;

    state.translatorPrompt = preset.prompt;
    state.translatorMaxResponse = preset.maxResponse;

    return state;
}

export function getCurrentTranslatorPresetFromState<T extends TranslatorPresetStateLike>(
    state: T
): TranslatorPreset {
    const preset = state.translatorPresets![state.translatorPresetId!] as TranslatorPreset;

    state.translatorPrompt = preset.prompt;
    state.translatorMaxResponse = preset.maxResponse;

    return preset;
}

async function decodeEncryptedTranslatorPresetFile(data: Uint8Array): Promise<TranslatorPreset> {
    let encodedPreset: Uint8Array;
    try {
        encodedPreset = await decodeRPack(data);
    } catch {
        throw new Error("Invalid translator preset file.");
    }

    let decodedContainer: unknown;

    try {
        decodedContainer = decodeMsgpack(fflate.decompressSync(encodedPreset));
    } catch {
        throw new Error("Invalid translator preset file.");
    }

    if (!isEncryptedTranslatorPresetFile(decodedContainer)) {
        throw new Error("Invalid translator preset file.");
    }

    const encryptedPreset = getBytes(decodedContainer.preset);

    if (!encryptedPreset) {
        throw new Error("Invalid translator preset file.");
    }

    let decryptedPreset: ArrayBuffer;

    try {
        decryptedPreset = await decryptBuffer(encryptedPreset, translatorPresetEncryptionKey);
    } catch {
        throw new Error("Invalid translator preset file.");
    }

    const parsedPreset: unknown = decodeMsgpack(new Uint8Array(decryptedPreset));

    if (!isTranslatorPresetInput(parsedPreset)) {
        throw new Error("Invalid translator preset file.");
    }

    return createTranslatorPreset(
        parsedPreset.name.trim().length > 0 ? parsedPreset.name : "Imported Preset",
        parsedPreset
    );
}

export async function encodeTranslatorPresetFile(preset: TranslatorPreset): Promise<Uint8Array> {
    const normalizedPreset = createTranslatorPreset(
        preset.name.trim().length > 0 ? preset.name : "Preset",
        preset
    );
    const encryptedPreset = new Uint8Array(
        await encryptBuffer(encodeMsgpack(normalizedPreset), translatorPresetEncryptionKey)
    );
    const payload: EncryptedTranslatorPresetFile = {
        translatorPresetVersion: 1,
        type: "translator-preset",
        preset: encryptedPreset,
    };

    return await encodeRPack(fflate.compressSync(encodeMsgpack(payload)));
}

export async function decodeTranslatorPresetFile(data: Uint8Array): Promise<TranslatorPreset> {
    return await decodeEncryptedTranslatorPresetFile(data);
}

export function getTranslatorPresetDownloadName(name: string): string {
    return `translator_preset_${sanitizeFileNamePart(name)}.${translatorPresetFileExtension}`;
}
