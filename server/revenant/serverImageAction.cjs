'use strict';

const nodeCrypto = require('crypto');
const { resolveAssetPayload } = require('../utils/mime.cjs');

const imagePromptFormattingPromise = import('../imagePromptFormatting.mjs');

function imageGenerationSeed(provider, requestedSeed) {
    if (Number.isFinite(requestedSeed) && requestedSeed >= 0) return requestedSeed;
    const value = nodeCrypto.randomBytes(4).readUInt32BE(0);
    return provider === 'comfyui' ? value % 1_000_000_000 : value;
}

const IMAGE_INLAY_UUID_NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');

function imageInlayId(jobId) {
    const bytes = nodeCrypto.createHash('sha1')
        .update(IMAGE_INLAY_UUID_NAMESPACE)
        .update(`pocketrisu:image-inlay:${jobId}`)
        .digest()
        .subarray(0, 16);
    // Keep the ID deterministic for workflow recovery while matching the UUID
    // shape used by regular inlay assets. Mark it as a name-based UUID (v5).
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createServerImageActions(options) {
    const repository = options.repository || require('./generationDb.cjs');
    const {
        finishGenerationWorkflow,
        getGenerationWorkflow,
        updateGenerationWorkflowStep,
    } = repository;
    const {
        appDataStore,
        canonicalChatService,
        imageGenerationJobService,
        inlayService,
        getVips,
        kvGet,
        kvSet,
        onWorkflowUpdated,
    } = options;
    const {
        encodeInlayImageBuffer,
        normalizeInlayImageSettings,
        readInlayFile,
        writeInlayFile,
    } = inlayService;

    function currentServerImageGenerationSettings() {
        const database = appDataStore.exportProjection({ includeMessages: false });
        const preset = database.imageGenerationPresets?.[database.imageGenerationPresetId]
            ?? database.imageGenerationPresets?.[0];
        const settings = preset?.settings;
        if (!settings || typeof settings !== 'object') {
            throw new Error('Image generation preset is not configured');
        }
        const keyRef = settings.imageApiKeyRefs?.novelai;
        const apiKey = String(database.apiKeyPool?.[keyRef]?.key ?? settings.NAIApiKey ?? '').trim();
        return {
            settings: structuredClone(settings),
            apiKey,
            label: typeof preset.name === 'string' ? preset.name : String(settings.sdProvider || 'Image'),
            inlaySettings: normalizeInlayImageSettings({
                size: database.inlayImageCompression ? database.inlayImageSize : 'original',
                format: database.inlayImageCompression ? database.inlayImageFormat : 'png',
                lossy: database.inlayImageLossy,
                quality: database.inlayImageQuality,
            }),
        };
    }

    async function readServerImageReference(reference) {
        if (typeof reference !== 'string' || !reference) return null;
        if (reference.startsWith('data:')) {
            const comma = reference.indexOf(',');
            return comma >= 0 ? Buffer.from(reference.slice(comma + 1), 'base64') : null;
        }
        const inlayMatch = reference.match(/\{\{(?:inlay|inlayed|inlayeddata)::(.+?)\}\}/);
        if (inlayMatch) return (await readInlayFile(inlayMatch[1]))?.buffer || null;
        const stored = kvGet(reference);
        if (!stored) return null;
        if (reference.startsWith('inlay/')) {
            return resolveAssetPayload(reference, stored).binary;
        }
        return Buffer.from(stored);
    }

    async function prepareNovelAIDirectorReference(buffer) {
        const vips = await getVips();
        const source = vips.Image.newFromBuffer(buffer);
        let rotated = null;
        let resized = null;
        let embedded = null;
        try {
            rotated = source.autorot();
            const scale = Math.min(1472 / rotated.width, 1472 / rotated.height);
            resized = scale === 1 ? rotated : rotated.resize(scale, { kernel: vips.Kernel.lanczos3 });
            const x = Math.floor((1472 - resized.width) / 2);
            const y = Math.floor((1472 - resized.height) / 2);
            embedded = resized.embed(x, y, 1472, 1472, { extend: vips.Extend.black });
            return Buffer.from(embedded.writeToBuffer('.png', { Q: 100 }));
        } finally {
            if (embedded) embedded.delete();
            if (resized && resized !== rotated) resized.delete();
            if (rotated) rotated.delete();
            source.delete();
        }
    }

    async function executeServerImageAction({ workflow, action }) {
        const payload = action?.payload || {};
        const imageContext = workflow.context?.kind === 'image-generation' ? workflow.context : undefined;
        const target = payload.target || (imageContext
            ? imageContext.target
            : {
                characterId: workflow.characterId,
                roomId: workflow.roomId,
            });
        if (!target?.characterId || !target?.roomId) throw new Error('Image generation target is missing');
        const config = currentServerImageGenerationSettings();
        const provider = config.settings.sdProvider;
        const seed = imageGenerationSeed(provider, payload.seed);
        const jobId = `${workflow.workflowId}:${action.actionId}`;
        let references;
        if (provider === 'novelai') {
            const database = appDataStore.exportProjection({ includeMessages: false });
            const character = database.characters?.find(item => item?.chaId === target.characterId);
            const imageConfig = config.settings.NAIImgConfig || {};
            const fallbackImage = character?.image;
            const initImage = config.settings.NAII2I
                ? await readServerImageReference(imageConfig.image || fallbackImage)
                : null;
            const rawDirectorReference = imageConfig.reference_mode === 'reference'
                ? await readServerImageReference(imageConfig.character_image || fallbackImage)
                : null;
            const directorReference = rawDirectorReference
                ? await prepareNovelAIDirectorReference(rawDirectorReference)
                : null;
            references = {
                ...(initImage ? { initImageBase64: initImage.toString('base64') } : {}),
                ...(directorReference
                    ? { directorReferenceBase64: directorReference.toString('base64') }
                    : {}),
            };
        }
        const promptFormatting = await imagePromptFormattingPromise;
        const rawPrompt = String(payload.prompt || '');
        const requestPrompt = provider === 'novelai'
            ? promptFormatting.formatNovelAIPrompt(rawPrompt, config.settings.animaArtistTagCompatibility === true)
            : provider === 'comfyui'
                ? promptFormatting.formatComfyUIPrompt(rawPrompt, config.settings.animaArtistTagCompatibility === true)
                : rawPrompt;
        const negativePrompt = String(payload.negativePrompt || '');
        const generated = await imageGenerationJobService.executeImageGeneration({
            jobId,
            settings: provider === 'comfyui' ? {
                sdProvider: 'comfyui',
                comfyConfig: { timeout: config.settings.comfyConfig?.timeout },
            } : config.settings,
            apiKey: config.apiKey,
            prompt: requestPrompt,
            negativePrompt,
            orientation: payload.orientation,
            seed,
            references,
            bridgeId: payload.bridgeId || workflow.context?.comfyBridgeId,
        });
        let encoded;
        try {
            encoded = await encodeInlayImageBuffer(generated.image, config.inlaySettings);
        } finally {
            imageGenerationJobService.releaseResult(jobId);
        }
        const inlayId = imageInlayId(jobId);
        await writeInlayFile(inlayId, encoded.ext, encoded.buffer, {
            name: inlayId,
            type: 'image',
            width: encoded.width,
            height: encoded.height,
        });
        const now = Date.now();
        kvSet(`inlay_meta/${inlayId}`, Buffer.from(JSON.stringify({
            createdAt: now,
            updatedAt: now,
            charId: target.characterId,
            chatId: target.roomId,
            imageGeneration: { prompt: requestPrompt, negativePrompt, seed, preset: imageContext?.preset },
        })));
        const reference = `{{inlayed::${inlayId}}}`;
        const projection = imageContext
            ? imageContext.projection || 'append'
            : undefined;
        if (projection === 'append' || projection === 'reroll') {
            await canonicalChatService.commitServerMutation({
                characterId: target.characterId,
                chatId: target.roomId,
                reason: 'image-generation-result',
                mutate: chat => {
                    const messageId = String(payload.messageId || '');
                    if (projection === 'reroll') {
                        const message = chat.message.find(item => item?.chatId === messageId);
                        if (!message || message.kind !== 'imageGeneration') {
                            throw new Error('Image reroll target no longer exists');
                        }
                        const swipes = message.swipes ?? [message.data];
                        message.swipes = swipes.includes(reference) ? swipes : [...swipes, reference];
                        message.swipeId = message.swipes.indexOf(reference);
                        message.data = reference;
                        message.time = now;
                    }
                    else if (!chat.message.some(item => item?.chatId === messageId)) {
                        chat.message.push({
                            role: 'char',
                            data: reference,
                            kind: 'imageGeneration',
                            saying: target.characterId,
                            chatId: messageId,
                            time: now,
                        });
                    }
                    return chat;
                },
            });
        }
        return { reference, jobId, seed, label: config.label };
    }

    function scheduleImageGenerationWorkflow(workflowId) {
        void (async () => {
            const workflow = getGenerationWorkflow(workflowId);
            const step = workflow?.steps?.find(item => item.key === 'image.generate');
            const action = step?.metadata?.action;
            if (!workflow || !step || !action) return;
            try {
                const result = await executeServerImageAction({ workflow, action });
                updateGenerationWorkflowStep(workflowId, step.key, {
                    status: 'completed',
                    metadata: { ...step.metadata, schemaVersion: 1, result },
                });
                finishGenerationWorkflow(workflowId, 'completed');
            }
            catch (error) {
                updateGenerationWorkflowStep(workflowId, step.key, {
                    status: 'failed',
                    metadata: {
                        ...step.metadata,
                        schemaVersion: 1,
                        error: error instanceof Error ? error.message : String(error),
                    },
                });
                finishGenerationWorkflow(workflowId, 'failed');
            }
            onWorkflowUpdated(getGenerationWorkflow(workflowId));
        })();
    }

    return { executeServerImageAction, scheduleImageGenerationWorkflow };
}

module.exports = { createServerImageActions };
