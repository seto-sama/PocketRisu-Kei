import { decodeBinaryMessage } from '../network/binaryMessage'
import { Buffer } from 'buffer'
import { get } from "svelte/store"
import { getDatabase, type character } from "../storage/database.svelte"
import { notifyError } from "../alert"
import { readImage } from "../globalApi.svelte"
import { CharEmotion } from "../stores.svelte"
import { processZip } from "./processzip"
import { getApiKey } from "../preset/apiKeyPool"
import { setInlayMetaFields, writeInlayImage } from "./files/inlays"
import { getCurrentImageGenerationPreset } from "../imageGeneration/presets"
import { createEntityId } from 'src/ts/id';
import { createRevenantGenerationAuth } from './revenant/transport/client'
import { serviceComfyBridgeJob } from './revenant/workflow/comfyBridge'
import { getComfyBridgeId } from './revenant/workflow/comfyBridgeId'

const NOVELAI_MAX_SEED = 2**32 - 1
const COMFYUI_MAX_SEED = 999_999_999

const randomInteger = (min: number, max: number): number =>
    Math.floor(Math.random() * (max - min + 1)) + min

interface NodeImageGenerationJob {
    jobId: string
    status: 'queued' | 'waiting_client' | 'generating' | 'completed' | 'failed' | 'interrupted'
    progress?: { value: number, max: number, node?: string }
    error?: string
    result?: Uint8Array
    resultFormat?: string
}

async function readNodeImageJob(response: Response): Promise<NodeImageGenerationJob> {
    if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        throw new Error(error.error || `Image generation request failed: ${response.status}`)
    }
    const { metadata, bytes } = decodeBinaryMessage(new Uint8Array(await response.arrayBuffer()))
    return { ...metadata, result: bytes } as unknown as NodeImageGenerationJob
}

async function runNodeImageGenerationJob(arg: {
    jobId: string
    provider: 'novelai' | 'comfyui'
    spec: Record<string, unknown>
}): Promise<NodeImageGenerationJob> {
    const headers = {
        'content-type': 'application/json',
        'risu-auth': await createRevenantGenerationAuth(),
    }
    let response = await fetch('/api/image-generation/jobs?includeResult=1', {
        method: 'POST',
        headers,
        body: JSON.stringify(arg),
    })
    let job = await readNodeImageJob(response)
    if (arg.provider === 'comfyui') void serviceComfyBridgeJob(arg.jobId, job).catch(() => {})
    while (job.status === 'queued' || job.status === 'waiting_client' || job.status === 'generating') {
        await new Promise(resolve => setTimeout(resolve, 500))
        response = await fetch(
            `/api/image-generation/jobs/${encodeURIComponent(arg.jobId)}?includeResult=1`,
            { headers },
        )
        job = await readNodeImageJob(response)
    }
    if (job.status !== 'completed' || !job.result?.length) {
        throw new Error(job.error || `Image generation ended with status ${job.status}`)
    }
    return job
}

function createImageGenerationSeed(provider: string): number | undefined {
    if(provider === 'novelai') return randomInteger(0, NOVELAI_MAX_SEED)
    if(provider === 'comfyui') return randomInteger(0, COMFYUI_MAX_SEED)
    return undefined
}

function getNovelAIImageApiKey(directKey = ''): string {
    const db = getDatabase()
    const settings = getCurrentImageGenerationPreset(db).settings
    return (getApiKey(settings.imageApiKeyRefs?.novelai)?.key ?? directKey).trim()
}

export async function generateAIImage(
    genPrompt:string,
    currentChar:character,
    neg:string,
    returnSdData:string,
    requestedSeed?: number,
):Promise<string|false>{
    const db = getDatabase()
    const imageSettings = getCurrentImageGenerationPreset(db).settings
    if(imageSettings.sdProvider === 'novelai'){
        const generationSeed = requestedSeed ?? randomInteger(0, NOVELAI_MAX_SEED)
        genPrompt = genPrompt
            .replaceAll('\\(', "♧")
            .replaceAll('\\)', "♤")
            .replaceAll('(','{')
            .replaceAll(')','}')
            .replaceAll('♧','(')
            .replaceAll('♤',')')

        let reqlist:any = {}

        const commonReq = {
            body: {
                "input": genPrompt,
                "model": imageSettings.NAIImgModel,
                "parameters": {
                    "params_version": 3,
                    "add_original_image": true,
                    "cfg_rescale": imageSettings.NAIImgConfig.cfg_rescale,
                    "controlnet_strength": 1,
                    "n_samples": 1,
                    "width": imageSettings.NAIImgConfig.width,
                    "height": imageSettings.NAIImgConfig.height,
                    "sampler": imageSettings.NAIImgConfig.sampler,
                    "steps": imageSettings.NAIImgConfig.steps,
                    "scale": imageSettings.NAIImgConfig.scale,
                    "negative_prompt": neg,
                    "noise_schedule": imageSettings.NAIImgConfig.noise_schedule,
                    "normalize_reference_strength_multiple":true,
                    "ucPreset": 3,
                    "uncond_scale": 1,
                    "qualityToggle": false,
                    "legacy_v3_extend": false,
                    "legacy": false,
                    //add v4
                    "autoSmea": false,
                    "use_coords": false,
                    "legacy_uc": imageSettings.NAIImgConfig.legacy_uc,
                    "v4_prompt":{
                        caption:{
                            base_caption:genPrompt,
                            char_captions: []
                        },
                        use_coords: false,
                        use_order: true,
                    },
                    "v4_negative_prompt":{
                        caption:{
                            base_caption:neg,
                            char_captions: []
                        },
                        legacy_uc: imageSettings.NAIImgConfig.legacy_uc,
                    },
                    "reference_image_multiple" : [],
                    "reference_strength_multiple" : [],
                    //add reference image
                    "image": undefined,
                    "strength": undefined,
                    "noise": undefined,
                    //add additional parameters
                    "seed": generationSeed,
                    "extra_noise_seed": imageSettings.NAII2I ? generationSeed : undefined,
                    "prefer_brownian": true,
                    "deliberate_euler_ancestral_bug": false,
                    "skip_cfg_above_sigma": null,
                    //add character reference
                    "director_reference_images": [],
                    "director_reference_descriptions": [],
                    "director_reference_information_extracted": [],
                    "director_reference_strength_values": [],
                    "director_reference_secondary_strength_values": [],
                }
            },
            headers:{
                "Authorization": "Bearer " + getNovelAIImageApiKey(imageSettings.NAIApiKey)
            },
            rawResponse: true
        }

        // Add Variety+ option
        if(imageSettings.NAIImgConfig.variety_plus) {
            if(imageSettings.NAIImgModel.includes('nai-diffusion-4-full') || imageSettings.NAIImgModel.includes('nai-diffusion-4-curated')
            ) {
                commonReq.body.parameters.skip_cfg_above_sigma = Math.sqrt(imageSettings.NAIImgConfig.width * imageSettings.NAIImgConfig.height) * 0.01889;
            }
            if(imageSettings.NAIImgModel.includes('nai-diffusion-4-5-full') || imageSettings.NAIImgModel.includes('nai-diffusion-4-5-curated')) {
                commonReq.body.parameters.skip_cfg_above_sigma = Math.sqrt(imageSettings.NAIImgConfig.width * imageSettings.NAIImgConfig.height) * 0.05766;
            }
        }

        // Add vibe reference_image_multiple if exists
        if(imageSettings.NAIImgConfig.reference_mode === 'vibe' && imageSettings.NAIImgConfig.vibe_data) {
            const vibeData = imageSettings.NAIImgConfig.vibe_data;
            // Determine which model to use based on vibe_model_selection or fallback to current model
            const modelKey = imageSettings.NAIImgConfig.vibe_model_selection ||
                            (imageSettings.NAIImgModel.includes('nai-diffusion-4-full') ? 'v4full' :
                             imageSettings.NAIImgModel.includes('nai-diffusion-4-curated') ? 'v4curated' :
                             imageSettings.NAIImgModel.includes('nai-diffusion-4-5-full') ? 'v4-5full' :
                             imageSettings.NAIImgModel.includes('nai-diffusion-4-5-curated') ? 'v4-5curated' : null);

            if(modelKey && vibeData.encodings && vibeData.encodings[modelKey]) {
                // Initialize arrays if they don't exist
                if(!commonReq.body.parameters.reference_image_multiple) {
                    commonReq.body.parameters.reference_image_multiple = [];
                }
                if(!commonReq.body.parameters.reference_strength_multiple) {
                    commonReq.body.parameters.reference_strength_multiple = [];
                }

                // Use selected encoding or first available
                let encodingKey = imageSettings.NAIImgConfig.vibe_model_selection ?
                                 Object.keys(vibeData.encodings[modelKey]).find(key =>
                                    vibeData.encodings[modelKey][key].params.information_extracted ===
                                    (imageSettings.NAIImgConfig.InfoExtracted || 1)) :
                                 Object.keys(vibeData.encodings[modelKey])[0];

                if(encodingKey) {
                    const encoding = vibeData.encodings[modelKey][encodingKey].encoding;
                    // Add encoding to the array
                    commonReq.body.parameters.reference_image_multiple.push(encoding);

                    // Add reference_strength_multiple if it exists
                    const strength = imageSettings.NAIImgConfig.reference_strength_multiple &&
                                    imageSettings.NAIImgConfig.reference_strength_multiple.length > 0 ?
                                    imageSettings.NAIImgConfig.reference_strength_multiple[0] : 0.5;
                    commonReq.body.parameters.reference_strength_multiple.push(strength);
                }
            }
        }

        if(imageSettings.NAIImgConfig.reference_mode === 'reference' &&
            (imageSettings.NAIImgModel.includes('nai-diffusion-4-5-full') || imageSettings.NAIImgModel.includes('nai-diffusion-4-5-curated'))
        ) {
            let base64img = ''
            if(!imageSettings.NAIImgConfig.character_image || imageSettings.NAIImgConfig.character_image === ''){
                const charimg = currentChar.image;
                const img = await readImage(charimg)
                if (img) {
                    base64img = Buffer.from(img).toString('base64')
                }
            }
            else{
                const img = await readImage(imageSettings.NAIImgConfig.character_image)
                if (img) base64img = Buffer.from(img).toString('base64')
            }

            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                const imageObj = new Image();

                await new Promise<void>((resolve) => {
                    imageObj.onload = () => resolve();
                    imageObj.src = `data:image/png;base64,${base64img}`;
                });

                canvas.width = 1472;
                canvas.height = 1472;

                const scale = Math.min(1472 / imageObj.width, 1472 / imageObj.height);
                const scaledWidth = Math.floor(imageObj.width * scale);
                const scaledHeight = Math.floor(imageObj.height * scale);

                const x = (1472 - scaledWidth) / 2;
                const y = (1472 - scaledHeight) / 2;

                ctx.fillStyle = 'black';
                ctx.fillRect(0, 0, 1472, 1472);

                ctx.drawImage(imageObj, x, y, scaledWidth, scaledHeight);

                const blob = await new Promise<Blob>((resolve) => {
                    canvas.toBlob(resolve, 'image/png');
                });

                if (blob) {
                    const arrayBuffer = await blob.arrayBuffer();
                    base64img = Buffer.from(arrayBuffer).toString('base64');
                }
            } catch (error) {
                console.warn('Image resize failed, using original:', error);
            }

            if(base64img){
                const referenceType = ['character', 'style', 'character&style'].includes(imageSettings.NAIImgConfig.reference_type)
                    ? imageSettings.NAIImgConfig.reference_type
                    : 'character';
                const referenceStrength = Math.min(1, Math.max(0, imageSettings.NAIImgConfig.reference_strength ?? 1));
                const referenceFidelity = Math.min(1, Math.max(0, imageSettings.NAIImgConfig.reference_fidelity ?? 1));
                commonReq.body.parameters.director_reference_descriptions = [
                    {
                        caption: {
                            base_caption: referenceType,
                            char_captions: []
                        },
                        legacy_uc: imageSettings.NAIImgConfig.legacy_uc,
                    }
                ]
                commonReq.body.parameters.director_reference_images = [base64img]
                commonReq.body.parameters.director_reference_information_extracted = [1]
                commonReq.body.parameters.director_reference_strength_values = [referenceStrength]
                commonReq.body.parameters.director_reference_secondary_strength_values = [referenceFidelity]
            }
        }

        if(imageSettings.NAII2I){
            let base64img = ''
            if(!imageSettings.NAIImgConfig.image || imageSettings.NAIImgConfig.image === ''){
                const charimg = currentChar.image;

                const img = await readImage(charimg)
                if (img) {
                    base64img = Buffer.from(img).toString('base64')
                }
            }
            else{
                const img = await readImage(imageSettings.NAIImgConfig.image)
                if (img) base64img = Buffer.from(img).toString('base64')
            }

            if(base64img) {
                reqlist = commonReq;
                reqlist.body.action = "img2img";
                reqlist.body.parameters.image = base64img;
                reqlist.body.parameters.strength = imageSettings.NAIImgConfig.strength || 0.7;
                reqlist.body.parameters.noise = imageSettings.NAIImgConfig.noise || 0;
            }

        }else{

            reqlist = commonReq;
            reqlist.body.action = 'generate';

        }
        try {
            const job = await runNodeImageGenerationJob({
                jobId: `image:${createEntityId()}`,
                provider: 'novelai',
                spec: {
                    apiKey: getNovelAIImageApiKey(imageSettings.NAIApiKey),
                    body: reqlist.body,
                },
            })
            const result = Buffer.from(job.result!)

            if(returnSdData === 'inlay'){
                return await processZip(result)
            }

            else {
                let charemotions = get(CharEmotion)
                const img = await processZip(result);
                const emos:[string, string,number][] = [[img, img, Date.now()]]
                charemotions[currentChar.chaId] = emos
                CharEmotion.set(charemotions)
            }

            return returnSdData


        } catch (error) {
            notifyError(error)
            return false
        }
    }
    if(imageSettings.sdProvider === 'comfyui'){
        try {
            const job = await runNodeImageGenerationJob({
                jobId: `image:${createEntityId()}`,
                provider: 'comfyui',
                spec: {
                    prompt: genPrompt,
                    negativePrompt: neg,
                    seed: requestedSeed ?? randomInteger(0, COMFYUI_MAX_SEED),
                    bridgeId: getComfyBridgeId(),
                    timeoutSeconds: imageSettings.comfyConfig.timeout,
                },
            })
            const img64 = Buffer.from(job.result!).toString('base64')

            if(returnSdData === 'inlay'){
                return `data:image/png;base64,${img64}`
            }
            else {
                let charemotions = get(CharEmotion)
                const img = `data:image/png;base64,${img64}`
                const emos:[string, string,number][] = [[img, img, Date.now()]]
                charemotions[currentChar.chaId] = emos
                CharEmotion.set(charemotions)
            }

            return returnSdData
        } catch (error) {
            notifyError(error)
            return false
        }
    }
    return ''
}

export async function generateAIImageInlay(
    prompt: string,
    currentChar: character,
    negativePrompt = '',
    target?: { characterId: string, chatId: string },
    requestedSeed?: number,
): Promise<string | false> {
    const provider = getCurrentImageGenerationPreset(getDatabase()).settings.sdProvider
    const seed = requestedSeed ?? createImageGenerationSeed(provider)
    const generated = await generateAIImage(prompt, currentChar, negativePrompt, 'inlay', seed)
    if(!generated) return false

    const image = new Image()
    const inlayPromise = writeInlayImage(image)
    const loadError = new Promise<never>((_, reject) => {
        image.onerror = () => reject(new Error('Failed to load the generated image.'))
    })
    image.src = generated
    const inlayId = await Promise.race([inlayPromise, loadError])
    const targetCharacterId = target?.characterId ?? currentChar.chaId
    const targetChatId = target?.chatId ?? currentChar.chats?.[currentChar.chatPage]?.id
    await setInlayMetaFields(inlayId, {
        charId: targetCharacterId,
        chatId: targetChatId,
        imageGeneration: { prompt, negativePrompt, seed },
    })
    return `{{inlayed::${inlayId}}}`
}
