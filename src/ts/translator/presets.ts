import { normalizePresetTagFields, type PresetTagFields } from "src/ts/preset/tags";
import { appendPresetItem, duplicatePresetItem, movePresetItem, removePresetItem } from "src/ts/preset/collection";
import { createEntityId } from "src/ts/id";

export interface TranslatorPreset extends PresetTagFields {
    id: string;
    name: string;
    prompt: string;
}

export interface TranslatorPresetStateLike {
    translatorPrompt?: string;
    translatorPresets?: unknown[];
    translatorPresetId?: number;
    translatorPresetTags?: { id: string; name: string }[];
}

export const defaultTranslatorPrompt =
    "You are a translator. translate the following html or text into {{slot}}. do not output anything other than the translation.";
export const translatorPresetFileExtension = "risutl";

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
        (value.tagIds === undefined || (
            Array.isArray(value.tagIds) && value.tagIds.every(id => typeof id === "string")
        )) &&
        (value.folderId === undefined || typeof value.folderId === "string" || (
            Array.isArray(value.folderId) && value.folderId.every(id => typeof id === "string")
        ))
    );
}

function getDefaultTranslatorPreset(state: TranslatorPresetStateLike): TranslatorPreset {
    return createTranslatorPreset("Default", {
        prompt: state.translatorPrompt ?? "",
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
        ...existing,
        id: typeof existing.id === "string" && existing.id.length > 0 ? existing.id : createEntityId(),
        name,
        prompt: typeof existing.prompt === "string" ? existing.prompt : "",
        tagIds: existing.tagIds,
        folderId: existing.folderId,
    });
}

type TranslatorPresetCollection = {
    translatorPresets: TranslatorPreset[];
    translatorPresetId: number;
    translatorPrompt?: string;
};

export function appendTranslatorPreset(
    state: TranslatorPresetCollection,
    preset: TranslatorPreset,
): number {
    const result = appendPresetItem(state.translatorPresets, preset);
    state.translatorPresets = result.items;
    state.translatorPresetId = result.selectedIndex;
    syncCurrentTranslatorPresetToLegacyFields(state);
    return state.translatorPresetId;
}

export function duplicateTranslatorPreset(
    state: TranslatorPresetCollection,
    index: number,
    copyLabel: string,
): TranslatorPreset | undefined {
    const result = duplicatePresetItem(state.translatorPresets, index, source =>
        createTranslatorPreset(`${source.name} ${copyLabel}`, { ...source, id: undefined }));
    if (!result.changed) return undefined;
    state.translatorPresets = result.items;
    state.translatorPresetId = result.selectedIndex;
    syncCurrentTranslatorPresetToLegacyFields(state);
    return result.item;
}

export function moveTranslatorPreset(
    state: TranslatorPresetCollection,
    fromIndex: number,
    toIndex: number,
): boolean {
    const result = movePresetItem(state.translatorPresets, state.translatorPresetId, fromIndex, toIndex);
    if (!result.changed) return false;
    state.translatorPresets = result.items;
    state.translatorPresetId = result.selectedIndex;
    syncCurrentTranslatorPresetToLegacyFields(state);
    return result.changed;
}

export function removeTranslatorPreset(
    state: TranslatorPresetCollection,
    index: number,
): boolean {
    const result = removePresetItem(state.translatorPresets, state.translatorPresetId, index);
    if (!result.changed) return false;
    state.translatorPresets = result.items;
    state.translatorPresetId = result.selectedIndex;
    syncCurrentTranslatorPresetToLegacyFields(state);
    return result.changed;
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

    return state;
}

export function getCurrentTranslatorPresetFromState<T extends TranslatorPresetStateLike>(
    state: T
): TranslatorPreset {
    const preset = state.translatorPresets![state.translatorPresetId!] as TranslatorPreset;

    state.translatorPrompt = preset.prompt;

    return preset;
}

async function decodeEncryptedTranslatorPresetFile(data: Uint8Array): Promise<TranslatorPreset> {
    const { forageStorage } = await import('../storage/autoStorage');
    const parsedPreset: unknown = await forageStorage.decodeFile('translator', data);

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
    const { forageStorage } = await import('../storage/autoStorage');
    return forageStorage.encodeFile('translator', normalizedPreset);
}

export async function decodeTranslatorPresetFile(data: Uint8Array): Promise<TranslatorPreset> {
    return await decodeEncryptedTranslatorPresetFile(data);
}

export function getTranslatorPresetDownloadName(name: string): string {
    return `translator_preset_${sanitizeFileNamePart(name)}.${translatorPresetFileExtension}`;
}
