'use strict';

const {
    BINARY_MESSAGE_CONTENT_TYPE, encodeBinaryMessage,
    MAX_IMAGE_RESULT_BYTES: MAX_RESULT_BYTES, MAX_IMAGE_RESULT_MESSAGE_BYTES,
} = require('../protocol.cjs');
const { decodeBinaryRequest, binaryBodyParser } = require('../../binaryHttp.cjs');

function installImageGenerationJobRoutes(app, { checkProxyAuth, requireSyncClientId, service }) {
    const { jobs, publicJob, createJob, setProgress, finishBridgeJob, completeBridgeJob } = service;

    const sendJob = (req, res, job) => {
        if (req.query?.includeResult === '1') {
            res.set('content-type', BINARY_MESSAGE_CONTENT_TYPE);
            res.send(Buffer.from(encodeBinaryMessage(publicJob(job),
                job.status === 'completed' ? job.result : undefined).buffer));
        } else {
            res.send(publicJob(job));
        }
    };

    app.post('/api/image-generation/jobs', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        const jobId = typeof req.body?.jobId === 'string' ? req.body.jobId : '';
        const provider = req.body?.provider;
        if (!/^[a-zA-Z0-9._:/-]{1,256}$/.test(jobId) || !['novelai', 'comfyui'].includes(provider)) {
            res.status(400).send({ error: 'Invalid image generation job' });
            return;
        }
        const existing = jobs.get(jobId);
        if (existing) {
            sendJob(req, res, existing);
            return;
        }
        const spec = req.body?.spec;
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
            res.status(400).send({ error: 'Image generation spec is required' });
            return;
        }
        if (provider === 'novelai' && (typeof spec.apiKey !== 'string' || !spec.apiKey || !spec.body)) {
            res.status(400).send({ error: 'Invalid NovelAI image generation spec' });
            return;
        }
        if (provider === 'comfyui' && (
            typeof spec.prompt !== 'string'
            || typeof spec.negativePrompt !== 'string'
            || !Number.isFinite(spec.seed)
            || typeof spec.bridgeId !== 'string'
            || !/^[a-zA-Z0-9._:-]{1,128}$/.test(spec.bridgeId)
            || (spec.timeoutSeconds !== undefined && (
                !Number.isFinite(spec.timeoutSeconds)
                || spec.timeoutSeconds < 1
                || spec.timeoutSeconds > 600
            ))
        )) {
            res.status(400).send({ error: 'Invalid ComfyUI image generation spec' });
            return;
        }
        try {
            const job = createJob({ jobId, provider, spec });
            sendJob(req, res, job);
        } catch (error) {
            if (error?.code === 'IMAGE_JOB_LIMIT') {
                res.status(429).send({ error: error.message });
                return;
            }
            throw error;
        }
    });

    app.get('/api/image-generation/jobs/:jobId', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        const job = jobs.get(req.params.jobId);
        if (!job) {
            res.status(404).send({ error: 'Image generation job not found' });
            return;
        }
        sendJob(req, res, job);
    });

    const getBridgeJob = (req, res) => {
        const job = jobs.get(req.params.jobId);
        const bridgeId = typeof req.body?.bridgeId === 'string' ? req.body.bridgeId : '';
        if (!job || job.provider !== 'comfyui') {
            res.status(404).send({ error: 'ComfyUI bridge job not found' });
            return undefined;
        }
        if (!bridgeId || bridgeId !== job.bridgeId) {
            res.status(403).send({ error: 'ComfyUI bridge device does not own this job' });
            return undefined;
        }
        return job;
    };

    app.post('/api/image-generation/jobs/:jobId/comfy/submitted', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const job = getBridgeJob(req, res);
        if (!job) return;
        const promptId = typeof req.body?.promptId === 'string' ? req.body.promptId : '';
        const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId : '';
        if (!promptId || promptId.length > 256 || !clientId || clientId.length > 256) {
            res.status(400).send({ error: 'Invalid ComfyUI provider handle' });
            return;
        }
        if (job.providerHandle?.promptId && job.providerHandle.promptId !== promptId) {
            res.status(409).send({ error: 'A different ComfyUI prompt is already attached' });
            return;
        }
        if (!['waiting_client', 'generating'].includes(job.status)) {
            res.send(publicJob(job));
            return;
        }
        job.providerHandle = { promptId, clientId };
        job.status = 'generating';
        job.updatedAt = Date.now();
        res.send(publicJob(job));
    });

    app.post('/api/image-generation/jobs/:jobId/comfy/progress', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const job = getBridgeJob(req, res);
        if (!job) return;
        if (req.body?.promptId !== job.providerHandle?.promptId) {
            res.status(409).send({ error: 'ComfyUI prompt does not match this job' });
            return;
        }
        setProgress(job, Number(req.body?.value), Number(req.body?.max), req.body?.node);
        res.send(publicJob(job));
    });

    app.post('/api/image-generation/jobs/:jobId/comfy/complete', binaryBodyParser(MAX_IMAGE_RESULT_MESSAGE_BYTES), async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const message = decodeBinaryRequest(req, res);
        if (!message) return;
        req.body = message.metadata;
        const job = getBridgeJob(req, res);
        if (!job) return;
        if (req.body?.promptId !== job.providerHandle?.promptId) {
            res.status(409).send({ error: 'ComfyUI prompt does not match this job' });
            return;
        }
        if (job.status === 'completed') {
            res.send(publicJob(job));
            return;
        }
        if (!['generating', 'waiting_client'].includes(job.status)) {
            res.status(409).send({ error: `ComfyUI job is ${job.status}` });
            return;
        }
        const result = message.bytes;
        if (!result.length || result.length > MAX_RESULT_BYTES) {
            res.status(400).send({ error: 'Invalid ComfyUI image result' });
            return;
        }
        completeBridgeJob(job, result, req.body?.resultFormat);
        res.send(publicJob(job));
    });

    app.post('/api/image-generation/jobs/:jobId/comfy/fail', async (req, res) => {
        if (!await checkProxyAuth(req, res)) return;
        if (!requireSyncClientId(req, res)) return;
        const job = getBridgeJob(req, res);
        if (!job) return;
        if (job.status === 'completed') {
            res.send(publicJob(job));
            return;
        }
        finishBridgeJob(
            job,
            job.abortController.signal.aborted ? 'interrupted' : 'failed',
            String(req.body?.error || 'ComfyUI bridge failed').slice(0, 4000),
        );
        res.send(publicJob(job));
    });

}

module.exports = { installImageGenerationJobRoutes };
