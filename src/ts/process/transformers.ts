import type { TextToAudioPipeline } from '@huggingface/transformers';
import { unzip } from 'fflate';
import { loadAsset, saveAsset } from 'src/ts/globalApi.svelte';
import { selectSingleFile, asBuffer  } from 'src/ts/util';
import { v4 } from 'uuid';
let tfCache: Cache = null
let tfLoaded = false
let tfMap: { [key: string]: string } = {}

async function initTransformers() {
    if (tfLoaded) {
        return
    }
    const { env } = await import('@huggingface/transformers');
    tfCache = await caches.open('tfCache')
    env.localModelPath = "https://sv.risuai.xyz/transformers/"
    env.useBrowserCache = false
    env.useFSCache = false
    env.useCustomCache = true
    env.allowLocalModels = true
    env.customCache = {
        put: async (url: URL | string, response: Response) => {
            await tfCache.put(url, response)
        },
        match: async (url: URL | string) => {
            if (typeof url === 'string') {
                if (Object.keys(tfMap).includes(url)) {
                    const assetId = tfMap[url]
                    return new Response(asBuffer(await loadAsset(assetId)))
                }
            }
            return await tfCache.match(url)
        }
    }
    tfLoaded = true
    console.log('transformers loaded')
}

let synthesizer: TextToAudioPipeline = null
let lastSynth: string = null

export interface OnnxModelFiles {
    files: { [key: string]: string },
    id: string,
    name?: string
}

export const runVITS = async (text: string, modelData: string | OnnxModelFiles = 'Xenova/mms-tts-eng') => {
    await initTransformers()
    const { WaveFile } = await import('wavefile')
    const { pipeline, env } = await import('@huggingface/transformers');
    if (modelData === null) {
        return
    }
    if (typeof modelData === 'string') {
        if ((!synthesizer) || (lastSynth !== modelData)) {
            lastSynth = modelData
            synthesizer = await pipeline<"text-to-speech">('text-to-speech', modelData);
        }
    }
    else {
        if ((!synthesizer) || (lastSynth !== modelData.id)) {
            const files = modelData.files
            const keys = Object.keys(files)
            for (const key of keys) {
                const fileURL = env.localModelPath + modelData.id + '/' + key
                tfMap[fileURL] = files[key]
                tfMap[location.origin + fileURL] = files[key]
            }
            lastSynth = modelData.id
            synthesizer = await pipeline<"text-to-speech">('text-to-speech', modelData.id);
        }
    }
    let out = await synthesizer(text, {});
    const wav = new WaveFile();
    wav.fromScratch(1, out.sampling_rate, '32f', out.audio);
    const audioContext = new AudioContext();
    audioContext.decodeAudioData(asBuffer(wav.toBuffer().buffer), (decodedData) => {
        const sourceNode = audioContext.createBufferSource();
        sourceNode.buffer = decodedData;
        sourceNode.connect(audioContext.destination);
        sourceNode.start();
    });
}

export const registerOnnxModel = async (): Promise<OnnxModelFiles> => {
    const id = v4().replace(/-/g, '')

    const modelFile = await selectSingleFile(['zip'])

    if (!modelFile) {
        return
    }

    const unziped = await new Promise((res, rej) => {
        unzip(modelFile.data, {
            filter: (file) => {
                return file.name.endsWith('.onnx') || file.size < 10_000_000 || file.name.includes('.git')
            }
        }, (err, unzipped) => {
            if (err) {
                rej(err)
            }
            else {
                res(unzipped)
            }
        })
    })

    console.log(unziped)

    let fileIdMapped: { [key: string]: string } = {}

    const keys = Object.keys(unziped)
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i]
        const file = unziped[key]
        const fid = await saveAsset(file)
        let url = key
        if (url.startsWith('/')) {
            url = url.substring(1)
        }
        fileIdMapped[url] = fid
    }

    return {
        files: fileIdMapped,
        name: modelFile.name,
        id: id,
    }

}
