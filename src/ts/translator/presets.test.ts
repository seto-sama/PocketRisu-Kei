import { describe, expect, it, vi } from "vitest";

vi.mock("src/ts/util", () => ({
    encryptBuffer: async (data: Uint8Array) =>
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    decryptBuffer: async (data: Uint8Array) =>
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    // modules.ts (pulled in via the stores $effect) imports this from util
    checkPersonaBinded: () => null,
}));

vi.mock("src/ts/rpack/rpack_js.js", () => ({
    encodeRPack: async (data: Uint8Array) => data,
    decodeRPack: async (data: Uint8Array) => data,
}));

import {
    createTranslatorPreset,
    decodeTranslatorPresetFile,
    duplicateTranslatorPreset,
    encodeTranslatorPresetFile,
    getCurrentTranslatorPresetFromState,
    getTranslatorPresetDownloadName,
    normalizeTranslatorPresetState,
    type TranslatorPresetStateLike,
} from "./presets";

describe("normalizeTranslatorPresetState", () => {
    it("creates a default preset from legacy translator settings", () => {
        const state: TranslatorPresetStateLike = {
            translatorPrompt: "Translate to {{slot}}.",
        };

        normalizeTranslatorPresetState(state);

        expect(state.translatorPresets).toEqual([
            expect.objectContaining({
                id: expect.any(String),
                name: "Default",
                prompt: "Translate to {{slot}}.",
            }),
        ]);
        expect(state.translatorPresetId).toBe(0);
        expect(state.translatorPrompt).toBe("Translate to {{slot}}.");
    });

    it("clamps invalid preset ids and syncs the selected prompt", () => {
        const state: TranslatorPresetStateLike = {
            translatorPrompt: "legacy",
            translatorPresets: [
                {
                    name: "Fast",
                    prompt: "Fast preset",
                    maxResponse: 128,
                },
            ],
            translatorPresetId: 99,
        };

        normalizeTranslatorPresetState(state);

        expect(state.translatorPresetId).toBe(0);
        expect(state.translatorPrompt).toBe("Fast preset");
        expect(state.translatorPresets?.[0]).toEqual(expect.objectContaining({ maxResponse: 128 }));
    });

    it("keeps stable preset ids when presets are edited or reordered", () => {
        const first = createTranslatorPreset("First");
        const second = createTranslatorPreset("Second");
        first.prompt = "Edited prompt";
        const state: TranslatorPresetStateLike = {
            translatorPresets: [second, first],
            translatorPresetId: 1,
        };

        normalizeTranslatorPresetState(state);

        expect(state.translatorPresets?.map(preset => (preset as { id: string }).id))
            .toEqual([second.id, first.id]);
    });

    it("adds an id while normalizing a legacy preset that has none", () => {
        const state: TranslatorPresetStateLike = {
            translatorPresets: [{
                name: "Legacy",
                prompt: "Translate this",
                maxResponse: 256,
            }],
            translatorPresetId: 0,
        };

        normalizeTranslatorPresetState(state);

        expect(state.translatorPresets?.[0]).toEqual(expect.objectContaining({
            id: expect.any(String),
            name: "Legacy",
        }));
    });

});

describe("getCurrentTranslatorPresetFromState", () => {
    it("reuses a valid selected preset without renormalizing the preset array", () => {
        const presets = [
            createTranslatorPreset("Default", {
                prompt: "Default prompt",
            }),
            createTranslatorPreset("Detailed", {
                prompt: "Detailed prompt",
            }),
        ];
        const state: TranslatorPresetStateLike = {
            translatorPrompt: "legacy prompt",
            translatorPresets: presets,
            translatorPresetId: 1,
        };

        const preset = getCurrentTranslatorPresetFromState(state);

        expect(preset).toBe(presets[1]);
        expect(state.translatorPresets).toBe(presets);
        expect(state.translatorPrompt).toBe("Detailed prompt");
    });
});

describe("translator preset collection operations", () => {
    it("duplicates translator fields with a new stable id and syncs legacy fields", () => {
        const first = createTranslatorPreset("First", { prompt: "first", tagIds: ["tag-a"] });
        const state = {
            translatorPresets: [first],
            translatorPresetId: 0,
            translatorPrompt: "",
        };

        const duplicate = duplicateTranslatorPreset(state, 0, "Copy");

        expect(state.translatorPresetId).toBe(1);
        expect(duplicate?.name).toBe("First Copy");
        expect(duplicate?.id).not.toBe(first.id);
        expect(duplicate?.tagIds).toEqual(["tag-a"]);
        expect(duplicate?.tagIds).not.toBe(first.tagIds);
        expect(state.translatorPrompt).toBe("first");
    });
});

describe("translator preset file codec", () => {
    it("round-trips encrypted .risutl payloads without dropping legacy fields", async () => {
        const preset = Object.assign(
            createTranslatorPreset("My Preset", { prompt: "Translate into {{slot}}." }),
            { maxResponse: 256 }
        );

        const encoded = await encodeTranslatorPresetFile(preset);
        const decoded = await decodeTranslatorPresetFile(encoded);

        expect(decoded).toEqual(preset);
        expect(() => JSON.parse(new TextDecoder().decode(encoded))).toThrow();
        const downloadName = getTranslatorPresetDownloadName("My/Translator:Preset");
        expect(downloadName).toMatch(/\.risutl$/);
        expect(downloadName).not.toMatch(/[\\/:]/);
    });

    it("rejects plain JSON translator preset payloads", async () => {
        const plainJsonPayload = new TextEncoder().encode(
            JSON.stringify({
                type: "risu",
                ver: 1,
                data: {
                    name: "Plain JSON Preset",
                    prompt: "Plain JSON prompt",
                    maxResponse: 111,
                },
            })
        );

        await expect(decodeTranslatorPresetFile(plainJsonPayload)).rejects.toThrow(
            "Invalid translator preset file."
        );
    });
});
