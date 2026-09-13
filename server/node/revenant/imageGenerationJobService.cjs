'use strict';

const { unzipSync } = require('fflate');

const {
    MAX_IMAGE_RESULT_BYTES: MAX_RESULT_BYTES,
} = require('./protocol.cjs');
const MAX_RETAINED_RESULT_BYTES = 512 * 1024 * 1024;
const MAX_ACTIVE_JOBS = 32;
const RETENTION_MS = 10 * 60 * 1000;
const COMFY_RECONNECT_GRACE_MS = 30_000;
const NOVELAI_TIMEOUT_MS = 5 * 60 * 1000;

function createImageGenerationJobService({ logger = console } = {}) {
    const jobs = new Map();

    const publicJob = job => ({
        jobId: job.jobId,
        provider: job.provider,
        status: job.status,
        progress: job.progress,
        error: job.error,
        resultFormat: job.resultFormat,
        ...(job.provider === 'comfyui' ? {
            bridgeId: job.bridgeId,
            bridgeRequest: job.bridgeRequest,
            providerHandle: job.providerHandle,
        } : {}),
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
    });

    const setProgress = (job, value, max, node) => {
        if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return;
        job.progress = { value, max, ...(node ? { node: String(node) } : {}) };
        job.updatedAt = Date.now();
    };

    const clearJobTimer = job => {
        if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
        job.timeoutTimer = undefined;
    };

    const finishBridgeJob = (job, status, error) => {
        if (!['waiting_client', 'generating'].includes(job.status)) return false;
        clearJobTimer(job);
        job.status = status;
        job.error = error;
        job.updatedAt = Date.now();
        job.resolveRun?.();
        return true;
    };

    const pruneTerminalJobs = (protectedJobId) => {
        const cutoff = Date.now() - RETENTION_MS;
        const terminal = [...jobs.values()]
            .filter(job => !['queued', 'waiting_client', 'generating'].includes(job.status))
            .sort((left, right) => left.updatedAt - right.updatedAt);
        let retainedBytes = terminal.reduce((sum, job) => sum + (job.result?.length || 0), 0);
        for (const job of terminal) {
            if (job.jobId === protectedJobId) continue;
            if (job.updatedAt >= cutoff && retainedBytes <= MAX_RETAINED_RESULT_BYTES) continue;
            retainedBytes -= job.result?.length || 0;
            jobs.delete(job.jobId);
        }
    };

    async function runNovelAI(job, spec) {
        const timeoutSignal = AbortSignal.timeout(NOVELAI_TIMEOUT_MS);
        const response = await fetch('https://image.novelai.net/ai/generate-image', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${spec.apiKey}`,
            },
            body: JSON.stringify(spec.body),
            signal: AbortSignal.any([job.abortController.signal, timeoutSignal]),
        });
        const result = Buffer.from(await response.arrayBuffer());
        if (!response.ok) throw new Error(result.toString('utf8') || `NovelAI returned ${response.status}`);
        if (result.length > MAX_RESULT_BYTES) throw new Error('Image generation result is too large');
        job.result = result;
        job.resultFormat = 'novelai-zip';
    }

    function startJob(job, spec) {
        job.status = 'generating';
        job.updatedAt = Date.now();
        job.runPromise = runNovelAI(job, spec)
            .then(() => {
                job.status = 'completed';
                job.updatedAt = Date.now();
                pruneTerminalJobs(job.jobId);
            })
            .catch(error => {
                job.status = job.abortController.signal.aborted ? 'interrupted' : 'failed';
                job.error = error?.message || String(error);
                job.updatedAt = Date.now();
                logger.warn?.('[ImageGenerationJob] Failed:', job.jobId, job.error);
                pruneTerminalJobs(job.jobId);
            });
    }

    function startComfyBridgeJob(job, spec) {
        job.status = 'waiting_client';
        job.bridgeRequest = {
            prompt: spec.prompt,
            negativePrompt: spec.negativePrompt,
            seed: spec.seed,
        };
        job.bridgeId = spec.bridgeId;
        job.updatedAt = Date.now();
        job.runPromise = new Promise(resolve => { job.resolveRun = resolve; });
        const timeoutMs = Math.max(1, Math.min(600, Number(spec.timeoutSeconds) || 120)) * 1000
            + COMFY_RECONNECT_GRACE_MS;
        job.timeoutTimer = setTimeout(() => {
            if (finishBridgeJob(job, 'failed', 'ComfyUI bridge timed out waiting for the browser')) {
                logger.warn?.('[ImageGenerationJob] Bridge timeout:', job.jobId);
            }
        }, timeoutMs);
        job.timeoutTimer.unref?.();
    }

    function createJob({ jobId, provider, spec }) {
        const existing = jobs.get(jobId);
        if (existing) return existing;
        const activeCount = [...jobs.values()].filter(job =>
            ['queued', 'waiting_client', 'generating'].includes(job.status)).length;
        if (activeCount >= MAX_ACTIVE_JOBS) {
            const error = new Error('Too many active image generation jobs');
            error.code = 'IMAGE_JOB_LIMIT';
            throw error;
        }
        const now = Date.now();
        const job = {
            jobId, provider, status: 'queued', progress: undefined, error: undefined,
            result: undefined, resultFormat: undefined, createdAt: now, updatedAt: now,
            abortController: new AbortController(), runPromise: undefined,
        };
        jobs.set(jobId, job);
        if (provider === 'comfyui') startComfyBridgeJob(job, spec);
        else startJob(job, spec);
        return job;
    }

    async function waitForJob(job) {
        await job.runPromise;
        if (job.status !== 'completed' || !job.result) {
            throw new Error(job.error || `Image generation ended with status ${job.status}`);
        }
        return job;
    }

    function novelAIRequest(settings, prompt, negativePrompt, seed, apiKey, references = {}) {
        const config = settings.NAIImgConfig || {};
        const model = String(settings.NAIImgModel || 'nai-diffusion-3');
        const supportsV3 = model.includes('nai-diffusion-3')
            || model.includes('nai-diffusion-furry-3')
            || model.includes('nai-diffusion-2');
        const supportsV4 = model.includes('nai-diffusion-4');
        const parameters = {
            params_version: 3,
            add_original_image: true,
            cfg_rescale: config.cfg_rescale,
            controlnet_strength: 1,
            dynamic_thresholding: supportsV3 ? config.decrisp : false,
            n_samples: 1,
            width: config.width,
            height: config.height,
            sampler: config.sampler,
            steps: config.steps,
            scale: config.scale,
            negative_prompt: negativePrompt,
            sm: supportsV3 ? config.sm : undefined,
            sm_dyn: model.includes('nai-diffusion-3') || model.includes('nai-diffusion-furry-3')
                ? config.sm_dyn : undefined,
            noise_schedule: config.noise_schedule,
            normalize_reference_strength_multiple: true,
            ucPreset: 3,
            uncond_scale: 1,
            qualityToggle: false,
            legacy_v3_extend: false,
            legacy: false,
            autoSmea: false,
            use_coords: false,
            legacy_uc: config.legacy_uc,
            v4_prompt: {
                caption: { base_caption: prompt, char_captions: [] },
                use_coords: false,
                use_order: true,
            },
            v4_negative_prompt: {
                caption: { base_caption: negativePrompt, char_captions: [] },
                legacy_uc: config.legacy_uc,
            },
            reference_image_multiple: [],
            reference_strength_multiple: [],
            image: undefined,
            strength: undefined,
            noise: undefined,
            seed,
            extra_noise_seed: settings.NAII2I ? seed : undefined,
            prefer_brownian: true,
            deliberate_euler_ancestral_bug: false,
            skip_cfg_above_sigma: null,
            director_reference_images: [],
            director_reference_descriptions: [],
            director_reference_information_extracted: [],
            director_reference_strength_values: [],
            director_reference_secondary_strength_values: [],
        };
        if (config.variety_plus) {
            const pixels = Math.sqrt(Number(config.width) * Number(config.height));
            if (model.includes('nai-diffusion-4-5')) parameters.skip_cfg_above_sigma = pixels * 0.05766;
            else if (supportsV3 || supportsV4) parameters.skip_cfg_above_sigma = pixels * 0.01889;
        }
        if (config.reference_mode === 'vibe' && config.vibe_data?.encodings) {
            const modelKey = config.vibe_model_selection
                || (model.includes('nai-diffusion-4-5-full') ? 'v4-5full'
                    : model.includes('nai-diffusion-4-5-curated') ? 'v4-5curated'
                        : model.includes('nai-diffusion-4-full') ? 'v4full'
                            : model.includes('nai-diffusion-4-curated') ? 'v4curated' : null);
            const encodings = modelKey ? config.vibe_data.encodings[modelKey] : undefined;
            const encodingKey = encodings && (config.vibe_model_selection
                ? Object.keys(encodings).find(key => encodings[key]?.params?.information_extracted
                    === (config.InfoExtracted || 1))
                : Object.keys(encodings)[0]);
            if (encodingKey) {
                parameters.reference_image_multiple.push(encodings[encodingKey].encoding);
                parameters.reference_strength_multiple.push(config.reference_strength_multiple?.[0] ?? 0.5);
            }
        }
        if (settings.NAII2I && references.initImageBase64) {
            parameters.image = references.initImageBase64;
            parameters.strength = config.strength || 0.7;
            parameters.noise = config.noise || 0;
        }
        if (config.reference_mode === 'reference' && references.directorReferenceBase64) {
            const referenceType = ['character', 'style', 'character&style'].includes(config.reference_type)
                ? config.reference_type : 'character';
            parameters.director_reference_images = [references.directorReferenceBase64];
            parameters.director_reference_descriptions = [{
                caption: { base_caption: referenceType, char_captions: [] },
                legacy_uc: config.legacy_uc,
            }];
            parameters.director_reference_information_extracted = [1];
            parameters.director_reference_strength_values = [Math.min(1, Math.max(0, config.reference_strength ?? 1))];
            parameters.director_reference_secondary_strength_values = [Math.min(1, Math.max(0, config.reference_fidelity ?? 1))];
        }
        return {
            provider: 'novelai',
            spec: {
                apiKey,
                body: {
                    input: prompt,
                    model,
                    action: settings.NAII2I ? 'img2img' : 'generate',
                    parameters,
                },
            },
        };
    }

    function comfyUIRequest(settings, prompt, negativePrompt, seed, bridgeId) {
        return {
            provider: 'comfyui',
            spec: {
                prompt,
                negativePrompt,
                seed,
                bridgeId,
                timeoutSeconds: settings.comfyConfig?.timeout,
            },
        };
    }

    async function executeImageGeneration(arg) {
        const provider = arg.settings?.sdProvider;
        const request = provider === 'novelai'
            ? novelAIRequest(
                arg.settings, arg.prompt, arg.negativePrompt, arg.seed, arg.apiKey, arg.references,
            )
            : provider === 'comfyui'
                ? comfyUIRequest(arg.settings, arg.prompt, arg.negativePrompt, arg.seed, arg.bridgeId)
                : null;
        if (!request) throw new Error(`Unsupported server image provider: ${provider || 'none'}`);
        const job = createJob({ jobId: arg.jobId, ...request });
        await waitForJob(job);
        let image = job.result;
        if (job.resultFormat === 'novelai-zip') {
            const files = unzipSync(new Uint8Array(job.result));
            const key = Object.keys(files).find(name => /\.(?:png|jpe?g|webp)$/i.test(name));
            if (!key) throw new Error('NovelAI response did not contain an image');
            image = Buffer.from(files[key]);
        }
        return { job, image };
    }

    function completeBridgeJob(job, result, resultFormat) {
        // Retained results must not keep the upload metadata buffer alive.
        job.result = Buffer.from(result);
        job.resultFormat = ['png', 'jpeg', 'webp'].includes(resultFormat)
            ? resultFormat : 'png';
        job.status = 'completed';
        job.updatedAt = Date.now();
        clearJobTimer(job);
        job.resolveRun?.();
        pruneTerminalJobs(job.jobId);
    }

    const pruneTimer = setInterval(() => {
        pruneTerminalJobs();
    }, 60_000);
    pruneTimer.unref?.();

    return {
        abortWorkflow: async workflowId => {
            const waits = [];
            for (const job of jobs.values()) {
                if (!job.jobId.startsWith(`${workflowId}:`)
                    || !['queued', 'waiting_client', 'generating'].includes(job.status)) continue;
                job.abortController.abort();
                if (job.provider === 'comfyui') {
                    finishBridgeJob(job, 'interrupted', 'Image generation workflow was terminated');
                }
                if (job.runPromise) waits.push(job.runPromise);
            }
            await Promise.allSettled(waits);
        },
        abortAll: () => {
            for (const job of jobs.values()) {
                if (['queued', 'waiting_client', 'generating'].includes(job.status)) {
                    job.abortController.abort();
                    if (job.provider === 'comfyui') {
                        finishBridgeJob(job, 'interrupted', 'Image generation interrupted by server shutdown');
                    }
                }
            }
        },
        createJob,
        setProgress,
        finishBridgeJob,
        completeBridgeJob,
        executeImageGeneration,
        publicJob,
        releaseResult: jobId => {
            const job = jobs.get(jobId);
            if (job && !['queued', 'waiting_client', 'generating'].includes(job.status)) {
                job.result = undefined;
            }
        },
        waitForJob,
        jobs,
    };
}

module.exports = { createImageGenerationJobService };
