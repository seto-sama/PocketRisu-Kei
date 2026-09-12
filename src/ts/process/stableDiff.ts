import { get } from "svelte/store"
import { getDatabase, type character } from "../storage/database.svelte"
import { notifyError } from "../alert"
import { globalFetch, readImage } from "../globalApi.svelte"
import { CharEmotion } from "../stores.svelte"
import { processZip } from "./processzip"
import random from "lodash/random"
import { getApiKey } from "../preset/apiKeyPool"
import { setInlayMetaFields, writeInlayImage } from "./files/inlays"
import { getCurrentImageGenerationPreset } from "../imageGeneration/presets"
import { createEntityId } from 'src/ts/id';
import { createRevenantGenerationAuth } from './revenant/transport/client'
import { serviceComfyBridgeJob } from './revenant/workflow/comfyBridge'
import { getComfyBridgeId } from './revenant/workflow/comfyBridgeId'

// Vite replaces this expression at build time. With the default (undefined/false),
// the minifier removes the optional provider branches from production bundles.
const ENABLE_EXTRA_IMAGE_PROVIDERS = import.meta.env.VITE_EXTRA_IMAGE_PROVIDERS === 'TRUE'
const NOVELAI_MAX_SEED = 2**32 - 1
const COMFYUI_MAX_SEED = 999_999_999

interface NodeImageGenerationJob {
    jobId: string
    status: 'queued' | 'waiting_client' | 'generating' | 'completed' | 'failed' | 'interrupted'
    progress?: { value: number, max: number, node?: string }
    error?: string
    resultBase64?: string
    resultFormat?: string
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
    let job = await response.json().catch(() => ({})) as NodeImageGenerationJob & { error?: string }
    if (!response.ok) throw new Error(job.error || `Failed to start image generation: ${response.status}`)
    if (arg.provider === 'comfyui') void serviceComfyBridgeJob(arg.jobId, job).catch(() => {})
    while (job.status === 'queued' || job.status === 'waiting_client' || job.status === 'generating') {
        await new Promise(resolve => setTimeout(resolve, 500))
        response = await fetch(
            `/api/image-generation/jobs/${encodeURIComponent(arg.jobId)}?includeResult=1`,
            { headers },
        )
        job = await response.json().catch(() => ({})) as NodeImageGenerationJob & { error?: string }
        if (!response.ok) throw new Error(job.error || `Failed to read image generation: ${response.status}`)
    }
    if (job.status !== 'completed' || !job.resultBase64) {
        throw new Error(job.error || `Image generation ended with status ${job.status}`)
    }
    return job
}

function createImageGenerationSeed(provider: string): number | undefined {
    if(provider === 'novelai') return random(0, NOVELAI_MAX_SEED)
    if(provider === 'comfyui') return random(0, COMFYUI_MAX_SEED)
    return undefined
}

type ImageKeyProvider = 'openai' | 'novelai' | 'openai-compatible' | 'google'

function getImageApiKey(provider: ImageKeyProvider, directKey = ''): string {
    const db = getDatabase()
    const settings = getCurrentImageGenerationPreset(db).settings
    return (getApiKey(settings.imageApiKeyRefs?.[provider])?.key ?? directKey).trim()
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
    if(ENABLE_EXTRA_IMAGE_PROVIDERS && imageSettings.sdProvider === 'webui'){


        const uri = new URL(db.webUiUrl)
        uri.pathname = '/sdapi/v1/txt2img'
        try {
            const da = await globalFetch(uri.toString(), {
                body: {
                    "width": db.sdConfig.width,
                    "height": db.sdConfig.height,
                    "seed": -1,
                    "steps": db.sdSteps,
                    "cfg_scale": db.sdCFG,
                    "prompt": genPrompt,
                    "negative_prompt": neg,
                    "sampler_name": db.sdConfig.sampler_name,
                    "enable_hr": db.sdConfig.enable_hr,
                    "denoising_strength": db.sdConfig.denoising_strength,
                    "hr_scale": db.sdConfig.hr_scale,
                    "hr_upscaler": db.sdConfig.hr_upscaler
                },
                headers:{
                    'Content-Type': 'application/json'
                }
            })

            if(returnSdData === 'inlay'){
                if(da.ok){
                    return `data:image/png;base64,${da.data.images[0]}`
                }
                else{
                    notifyError(JSON.stringify(da.data))
                    return ''
                }
            }
            else if(da.ok){
                let charemotions = get(CharEmotion)
                const img = `data:image/png;base64,${da.data.images[0]}`
                const emos:[string, string,number][] = [[img, img, Date.now()]]
                charemotions[currentChar.chaId] = emos
                CharEmotion.set(charemotions)
            }
            else{
                notifyError(JSON.stringify(da.data))
                return false
            }

            return returnSdData


        } catch (error) {
            notifyError(error)
            return false
        }
    }
    if(imageSettings.sdProvider === 'novelai'){
        const generationSeed = requestedSeed ?? random(0, NOVELAI_MAX_SEED)
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
                    "dynamic_thresholding": imageSettings.NAIImgModel.includes('nai-diffusion-3') || imageSettings.NAIImgModel.includes('nai-diffusion-furry-3') || imageSettings.NAIImgModel.includes('nai-diffusion-2') ? imageSettings.NAIImgConfig.decrisp : false,
                    "n_samples": 1,
                    "width": imageSettings.NAIImgConfig.width,
                    "height": imageSettings.NAIImgConfig.height,
                    "sampler": imageSettings.NAIImgConfig.sampler,
                    "steps": imageSettings.NAIImgConfig.steps,
                    "scale": imageSettings.NAIImgConfig.scale,
                    "negative_prompt": neg,
                    "sm": imageSettings.NAIImgModel.includes('nai-diffusion-3') || imageSettings.NAIImgModel.includes('nai-diffusion-furry-3') || imageSettings.NAIImgModel.includes('nai-diffusion-2') ? imageSettings.NAIImgConfig.sm : undefined,
                    "sm_dyn": imageSettings.NAIImgModel.includes('nai-diffusion-3') || imageSettings.NAIImgModel.includes('nai-diffusion-furry-3') ? imageSettings.NAIImgConfig.sm_dyn : undefined,
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
                "Authorization": "Bearer " + getImageApiKey('novelai', imageSettings.NAIApiKey)
            },
            rawResponse: true
        }

        // Add Variety+ option
        if(imageSettings.NAIImgConfig.variety_plus) {
            if(imageSettings.NAIImgModel.includes('nai-diffusion-4-full') || imageSettings.NAIImgModel.includes('nai-diffusion-4-curated')
            || imageSettings.NAIImgModel.includes('nai-diffusion-3') || imageSettings.NAIImgModel.includes('nai-diffusion-furry-3')) {
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
                    apiKey: getImageApiKey('novelai', imageSettings.NAIApiKey),
                    body: reqlist.body,
                },
            })
            const result = Buffer.from(job.resultBase64!, 'base64')

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
    if(ENABLE_EXTRA_IMAGE_PROVIDERS && imageSettings.sdProvider === 'dalle'){
        const da = await globalFetch("https://api.openai.com/v1/images/generations", {
            body: {
                "prompt": genPrompt,
                "model": "dall-e-3",
                "response_format": "b64_json",
                "style": "natural",
                "quality": db.dallEQuality || 'standard'
            },
            headers: {
                "Authorization": "Bearer " + getImageApiKey('openai', db.openAIKey)
            }
        })

        if(returnSdData === 'inlay'){
            let res = da?.data?.data?.[0]?.b64_json
            if(!res){
                notifyError(JSON.stringify(da.data))
                return ''
            }
            return `data:image/png;base64,${res}`
        }

        else if(da.ok){
            let charemotions = get(CharEmotion)
            let img = da?.data?.data?.[0]?.b64_json
            if(!img){
                notifyError(JSON.stringify(da.data))
                return false
            }
            img = `data:image/png;base64,${img}`
            const emos:[string, string,number][] = [[img, img, Date.now()]]
            charemotions[currentChar.chaId] = emos
            CharEmotion.set(charemotions)
        }
        else{
            notifyError(Buffer.from(da.data).toString())
            return false
        }
        return returnSdData
    }
    if(ENABLE_EXTRA_IMAGE_PROVIDERS && imageSettings.sdProvider === 'stability'){
        const formData = new FormData()
        const model = db.stabilityModel
        formData.append('prompt', genPrompt)
        if(model !== 'core' && model !== 'ultra'){
            formData.append('negative_prompt', neg)
            formData.append('model', model)
        }
        if(model === 'core'){
            if(db.stabllityStyle){
                formData.append('style_preset', db.stabllityStyle)
            }
        }
        if(model === 'ultra'){
            formData.append('negative_prompt', neg)
        }

        const uri = model === 'core' ? 'core' : model === 'ultra' ? 'ultra' : 'sd3'
        const da = await fetch("https://api.stability.ai/v2beta/stable-image/generate/" + uri, {
            body: formData,
            headers:{
                "authorization": "Bearer " + db.stabilityKey,
                "accept": "image/*"
            },
            method: 'POST'
        })

        const res = await da.arrayBuffer()
        if(!da.ok){
            notifyError(Buffer.from(res).toString())
            return false
        }

        if((da.headers["content-type"] ?? "").startsWith('application/json')){
            notifyError(Buffer.from(res).toString())
            return false
        }

        if(returnSdData === 'inlay'){
            return `data:image/png;base64,${Buffer.from(res).toString('base64')}`
        }

        let charemotions = get(CharEmotion)
        const img = `data:image/png;base64,${Buffer.from(res).toString('base64')}`
        const emos:[string, string,number][] = [[img, img, Date.now()]]
        charemotions[currentChar.chaId] = emos
        CharEmotion.set(charemotions)
        return returnSdData


    }

    if(imageSettings.sdProvider === 'comfyui'){
        try {
            const job = await runNodeImageGenerationJob({
                jobId: `image:${createEntityId()}`,
                provider: 'comfyui',
                spec: {
                    prompt: genPrompt,
                    negativePrompt: neg,
                    seed: requestedSeed ?? random(0, COMFYUI_MAX_SEED),
                    bridgeId: getComfyBridgeId(),
                    timeoutSeconds: imageSettings.comfyConfig.timeout,
                },
            })
            const img64 = job.resultBase64!

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
    if(ENABLE_EXTRA_IMAGE_PROVIDERS && imageSettings.sdProvider === 'fal'){
        const model = db.falModel
        const token = db.falToken

        let body:{[key:string]:any} = {
            prompt: genPrompt,
            enable_safety_checker: false,
            sync_mode: true,
            image_size: {
                "width": db.sdConfig.width,
                "height": db.sdConfig.height,
            }
        }

        if(db.falModel === 'fal-ai/flux-lora'){
            let loraPath = db.falLora
            if(loraPath.startsWith('urn:') || loraPath.startsWith('civitai:')){
                const id = loraPath.split('@').pop()
                loraPath = `https://civitai.com/api/download/models/${id}?type=Model&format=SafeTensor`
            }
            body.loras = [{
                "path": loraPath,
                "scale": db.falLoraScale
            }]
        }

        if(db.falModel === 'fal-ai/flux-pro'){
            delete body.enable_safety_checker
        }

        const res = await globalFetch('https://fal.run/' + model, {
            headers: {
                "Authorization": "Key " + token,
                "Content-Type": "application/json"
            },
            method: 'POST',
            body: body
        })

        if(!res.ok){
            notifyError(JSON.stringify(res.data))
            return false
        }

        let image = res.data?.images?.[0]?.url
        if(!image){
            notifyError(JSON.stringify(res.data))
            return false
        }

        if(returnSdData === 'inlay'){
            return image
        }
        else{
            let charemotions = get(CharEmotion)
            const emos:[string, string,number][] = [[image, image, Date.now()]]
            charemotions[currentChar.chaId] = emos
            CharEmotion.set(charemotions)
        }
    }
    if(ENABLE_EXTRA_IMAGE_PROVIDERS && imageSettings.sdProvider === 'Imagen') {
        const model = db.ImagenModel
        const size = db.ImagenImageSize
        const aspect = db.ImagenAspectRatio
        const person = db.ImagenPersonGeneration

        let body:any = {
            instances: [{
                prompt: genPrompt
            }],
            parameters: {
                sampleCount: 1,
                aspectRatio: aspect,
                personGeneration: person,
            }
        }

        if(model === 'imagen-4.0-generate-001' || model === 'imagen-4.0-ultra-generate-001') {
            body.parameters = {
                ...body.parameters,
                sampleImageSize: size
            }
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${getImageApiKey('google', db.google.accessToken)}`

        const res = await globalFetch(url, {
            headers: {
                "Content-Type": "application/json"
            },
            method: 'POST',
            body: body,
        })

        if(!res.ok) {
            notifyError(JSON.stringify(res.data))
            return false
        }

        const img64 = res.data?.predictions?.[0]?.bytesBase64Encoded

        if(!img64) {
            notifyError(JSON.stringify(res.data))
            return false
        }

        const mimeType = res.data?.predictions?.[0]?.mimeType || 'image/png'
        return `data:${mimeType};base64,${img64}`
    }
    if(ENABLE_EXTRA_IMAGE_PROVIDERS && imageSettings.sdProvider === 'openai-compat'){
        const config = db.openaiCompatImage
        if(!config.url){
            notifyError("OpenAI Compatible API URL is not set")
            return false
        }

        const body: {[key:string]: any} = {
            "prompt": genPrompt,
            "response_format": "b64_json",
            "size": config.size || "1024x1024",
            "quality": config.quality || "auto"
        }

        if(config.model){
            body.model = config.model
        }

        const headers: {[key:string]: string} = {
            "Content-Type": "application/json"
        }

        const apiKey = getImageApiKey('openai-compatible', config.key)
        if(apiKey){
            headers["Authorization"] = "Bearer " + apiKey
        }

        const da = await globalFetch(config.url, {
            body: body,
            headers: headers
        })

        if(returnSdData === 'inlay'){
            let res = da?.data?.data?.[0]?.b64_json
            if(!res){
                notifyError(JSON.stringify(da.data))
                return ''
            }
            return `data:image/png;base64,${res}`
        }

        if(da.ok){
            let charemotions = get(CharEmotion)
            let img = da?.data?.data?.[0]?.b64_json
            if(!img){
                notifyError(JSON.stringify(da.data))
                return false
            }
            img = `data:image/png;base64,${img}`
            const emos:[string, string,number][] = [[img, img, Date.now()]]
            charemotions[currentChar.chaId] = emos
            CharEmotion.set(charemotions)
        }
        else{
            notifyError(JSON.stringify(da.data))
            return false
        }
        return returnSdData
    }
    if(ENABLE_EXTRA_IMAGE_PROVIDERS && imageSettings.sdProvider === 'wavespeed'){
        const config = db.wavespeedImage
        if (!config.key) {
            notifyError('Please enter wavespeed API key')
            return false
        }
        const body: {[key:string]: any} = {}

        // Prompt
        body.prompt = genPrompt

        // reference image
        let base64img = ''
        if (config.reference_mode === 'image') {
            // reference: uploaded image
            base64img = config.reference_base64image
        }
        else if (config.reference_mode === 'character') {
            // reference: auto use the character's default image
            const charimg = currentChar.image;
            const img = await readImage(charimg)
            if (img) {
                base64img = Buffer.from(img).toString('base64')
            }
        }
        if(base64img){
            body.images = [base64img]
        }

        // LoRAs
        if (config.loras && Array.isArray(config.loras)) {
            body.loras = [];
            for (const lora of config.loras) {
                if (lora && lora.path && lora.path.trim() !== "") {
                    body.loras.push({
                        path: lora.path,
                        scale: typeof lora.scale === 'number' ? lora.scale : 1.0
                    });
                }
            }
        }

        // Request
        try {
            // First: submit task
            const requestEndpoint = `https://api.wavespeed.ai/api/v3/${config.model}`
            const requestResponse = await globalFetch(requestEndpoint, {
                body: body,
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + config.key
                }
            })
            let requestId: string;
            if (requestResponse.ok) {
                /*
                * submit response:
                * {
                *   code: number = HTTP status code (e.g., 200 for success)
                *   message: string = Status message (e.g., “success”)
                *   data: {
                *     id: string = Unique identifier for the prediction, Task Id
                *   }
                * }
                * */
                requestId = requestResponse.data.data.id
            }
            else {
                notifyError(`Submit task failed ${requestResponse.status}: ${requestResponse.data}`)
                return false
            }

            // Second: monitor task
            const taskEndpoint = `https://api.wavespeed.ai/api/v3/predictions/${requestId}/result`
            let resultEndpoint: string;
            const POLL_INTERVAL = 3000; // monitor every 3 seconds
            const MAX_WAIT_TIME = 10 * 60 * 1000; // 10 minutes absolute timeout
            const startTime = Date.now();
            while (true) {
                const elapsedTime = Date.now() - startTime;
                if (elapsedTime > MAX_WAIT_TIME) {
                    notifyError(`Task timeout after ${MAX_WAIT_TIME / 1000}s`);
                    break;
                }
                const taskResponse = await globalFetch(taskEndpoint, {
                    method: 'GET',
                    headers: {
                        "Authorization": "Bearer " + config.key
                    }
                })
                if (taskResponse.ok) {
                    /*
                    * monitor response:
                    * {
                    *   code: number = HTTP status code (e.g., 200 for success)
                    *   message: string = Status message (e.g., “success”)
                    *   data: {
                    *     status: string = Status of the task: created, processing, completed, or failed
                    *     outputs: string[] = Array of URLs to the generated content (empty when status is not completed)
                    *   }
                    * }
                    * */
                    if (taskResponse.data.data.status === 'completed') {
                        resultEndpoint = taskResponse.data.data.outputs[0]
                        break
                    }
                    else if (taskResponse.data.data.status === 'failed') {
                        notifyError(JSON.stringify(taskResponse.data))
                        break
                    }
                    // else keep loop
                    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
                }
                else {
                    notifyError(JSON.stringify(taskResponse.data))
                    break
                }
            }
            if (!resultEndpoint) {
                notifyError('Task finished but no result URL')
                return false
            }

            // Third: get result
            const resultResponse = await globalFetch(resultEndpoint, {
                method: 'GET',
                headers: {
                    "Authorization": "Bearer " + config.key
                },
                rawResponse: true
            })
            if (resultResponse.ok) {
                // mime-type: jpeg (default), png, webp
                const contentType = resultResponse.headers?.['content-type'] || 'image/jpeg'
                const mimeType = contentType.split(';')[0] // resolve "image/png; charset=utf-8"

                // binary image file, need to convert to base64
                const binary = resultResponse.data
                const res = Buffer.from(binary).toString('base64');
                const img = `data:${mimeType};base64,${res}`

                // inlay mode
                if(returnSdData === 'inlay'){
                    return img
                }
                // default mode
                else {
                    let charemotions = get(CharEmotion)
                    charemotions[currentChar.chaId] = [[img, img, Date.now()]]
                    CharEmotion.set(charemotions)
                    return returnSdData
                }
            }
            else {
                notifyError(JSON.stringify(resultResponse.data))
                return false
            }
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
