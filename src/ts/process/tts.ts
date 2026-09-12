import { notifyError } from "../alert";
import { getCurrentCharacter, getDatabase, type character, type TTSApiKeyProvider } from "../storage/database.svelte";
import { translateVox } from "../translator/translator";
import { globalFetch } from "../globalApi.svelte";
import { language } from "src/lang";
import { getApiKey } from "../preset/apiKeyPool";
import { getActiveTTSPreset, getBoundTTSPreset, type TTSPresetSettings } from "../tts/presets";
import {
    getTTSPreprocessors,
    getTTSPostprocessors,
    runHookPipeline,
    type BeforeTTSContext,
    type BeforeTTSResult,
    type AfterTTSContext,
    type AfterTTSResult,
} from "./ttsHooks";

let sourceNode: AudioBufferSourceNode | null = null
let playbackContext: AudioContext | null = null

function getTTSPlaybackVolume(): number {
    const value = getDatabase().ttsVolume ?? 100
    return Math.min(1, Math.max(0, value / 100))
}

/** Resolve a saved TTS key at request time so edits in the key pool take effect immediately. */
export function getTTSApiKey(provider: TTSApiKeyProvider, directKey = '', settings?: TTSPresetSettings): string {
    const db = getDatabase()
    const current = settings ?? getActiveTTSPreset(db)?.settings
    const ref = current?.apiKeyRefs?.[provider]
    const presetKey = provider === 'elevenlabs' ? current?.elevenLabsKey : current?.fishAudioKey
    return (getApiKey(ref)?.key ?? presetKey ?? directKey).trim()
}

function getTTSVoicevoxUrl(settings?: TTSPresetSettings): string {
    const db = getDatabase()
    return (settings?.voicevoxUrl ?? getActiveTTSPreset(db)?.settings.voicevoxUrl ?? '').trim().replace(/\/+$/, '')
}

/**
 * Run every registered TTS postprocessor hook against the audio bytes, honoring
 * replacement audio / mimeType / skip semantics. Before each hook invocation a
 * fresh slice of the current base audio is handed to the hook as its disposable
 * copy — the plugin sandbox postMessage layer transfers that buffer into the
 * iframe and neuters it on the host side, so reusing a single slice across
 * multiple hooks would leave all hooks after the first with a detached buffer.
 *
 * Returns the final audio bytes (possibly replaced by a hook), the final
 * mimeType, and whether a hook requested a skip.
 */
async function runPostprocessorPipeline(
    audio: ArrayBuffer,
    mimeType: string,
    ctx: { ttsMode: string; characterId: string },
): Promise<{ audio: ArrayBuffer; mimeType: string; skip: boolean }> {
    const hooks = getTTSPostprocessors();
    if (hooks.length === 0) return { audio, mimeType, skip: false };

    let currentAudio = audio;
    let currentMime = mimeType;

    for (const hook of hooks) {
        const disposable = currentAudio.slice(0); // fresh clone per hook
        let result: AfterTTSResult | void;
        try {
            result = await Promise.resolve().then(() =>
                hook({
                    audio: disposable,
                    mimeType: currentMime,
                    ttsMode: ctx.ttsMode,
                    characterId: ctx.characterId,
                })
            );
        } catch (err) {
            console.error('[TTS postprocessor] threw, continuing with next hook:', err);
            continue;
        }

        if (!result) continue;
        if (result.skip) return { audio: currentAudio, mimeType: currentMime, skip: true };
        if (result.audio && result.audio.byteLength > 0) currentAudio = result.audio;
        if (typeof result.mimeType === 'string' && result.mimeType) currentMime = result.mimeType;
    }

    return { audio: currentAudio, mimeType: currentMime, skip: false };
}

async function playAudio(audio: ArrayBuffer, mimeType: string, ctx: { ttsMode: string; characterId: string }): Promise<void> {
    const processed = await runPostprocessorPipeline(audio, mimeType, ctx);
    if (processed.skip) return;

    stopBufferedTTS();
    const audioContext = new AudioContext();
    let decoded: AudioBuffer;
    try {
        decoded = await audioContext.decodeAudioData(processed.audio);
    } catch (error) {
        void audioContext.close();
        throw error;
    }
    const nextSource = audioContext.createBufferSource();
    nextSource.buffer = decoded;
    const gainNode = audioContext.createGain();
    gainNode.gain.value = getTTSPlaybackVolume();
    nextSource.connect(gainNode);
    gainNode.connect(audioContext.destination);
    sourceNode = nextSource;
    playbackContext = audioContext;
    nextSource.onended = () => {
        if (sourceNode === nextSource) sourceNode = null;
        if (playbackContext === audioContext) playbackContext = null;
        void audioContext.close();
    };
    nextSource.start();
}

function stopBufferedTTS() {
    const currentSource = sourceNode;
    const currentContext = playbackContext;
    sourceNode = null;
    playbackContext = null;
    if (currentSource) {
        currentSource.onended = null;
        try { currentSource.stop(); } catch {}
    }
    if (currentContext) void currentContext.close();
}

export async function sayTTS(character:character,text:string) {
    try {
        if(!character){
            const v = getCurrentCharacter()
            character = v
        }

        if(!text){
            return
        }
    
        let db = getDatabase()
        const preset = getBoundTTSPreset(db, character.ttsPresetId)
        if (!preset) return
        const settings = preset.settings
        text = text.replace(/\*/g,'')
    
        if(db.ttsReadOnlyQuoted){
            const matches = text.match(/["「](.*?)["」]/g)
            if(matches && matches.length > 0){
                text = matches.map(match => match.slice(1, -1)).join("");
            }
            else{
                text = ''
            }
        }

        const beforeResult = await runHookPipeline<BeforeTTSContext, BeforeTTSResult>(
            getTTSPreprocessors(),
            { text, ttsMode: settings.provider, characterId: character.chaId },
        );
        if (beforeResult.skip) {
            return;
        }
        text = beforeResult.ctx.text;

        switch(settings.provider){
            case "webspeech":{
                if(speechSynthesis && SpeechSynthesisUtterance){
                    const utterThis = new SpeechSynthesisUtterance(text);
                    const voices = speechSynthesis.getVoices();
                    let voiceIndex = 0
                    for(let i=0;i<voices.length;i++){
                        if(voices[i].name === settings.voice){
                            voiceIndex = i
                        }
                    }
                    utterThis.voice = voices[voiceIndex]
                    utterThis.volume = getTTSPlaybackVolume()
                    speechSynthesis.speak(utterThis)
                }
                break
            }
            case "elevenlab": {
                const voiceId = settings.voice.trim()
                const apiKey = getTTSApiKey('elevenlabs', '', settings)
                if (!apiKey) throw new Error(language.ttsApiKeyMissing('ElevenLabs'))
                if (!voiceId) throw new Error(language.ttsVoiceNotSelected('ElevenLabs'))
                const da = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
                    body: JSON.stringify({
                        text: text,
                        model_id: "eleven_v3"
                    }),
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        'xi-api-key': apiKey
                    }
                })
                if(da.status >= 200 && da.status < 300){
                    const buffer = await da.arrayBuffer()
                    const mimeType = da.headers.get('content-type') || 'audio/mpeg'
                    await playAudio(buffer, mimeType, { ttsMode: settings.provider, characterId: character.chaId })
                }
                else{
                    notifyError(await da.text())
                }
                break
            }
            case "VOICEVOX": {
                const jpText = await translateVox(text)
                const baseUrl = getTTSVoicevoxUrl(settings)
                const speaker = settings.voice.trim()
                if (!baseUrl) throw new Error(language.ttsUrlNotConfigured('VOICEVOX'))
                if (!speaker) throw new Error(language.ttsVoiceNotSelected('VOICEVOX'))
                const params = new URLSearchParams({ text: jpText, speaker })
                const query = await fetch(`${baseUrl}/audio_query?${params}`, {
                    method: 'POST',
                    headers: { "Content-Type": "application/json"},
                })
                if (query.status == 200){
                    const queryJson = await query.json();
                    const config = settings.voicevox
                    queryJson.speedScale = config.speedScale
                    queryJson.pitchScale = config.pitchScale
                    queryJson.volumeScale = config.volumeScale
                    queryJson.intonationScale = config.intonationScale
                    const getVoice = await fetch(`${baseUrl}/synthesis?speaker=${encodeURIComponent(speaker)}`, {
                        method: 'POST',
                        headers: { "Content-Type": "application/json"},
                        body: JSON.stringify(queryJson),
                    })
                    if (getVoice.ok && getVoice.headers.get('content-type')?.startsWith('audio/wav')){
                        await playAudio(await getVoice.arrayBuffer(), 'audio/wav', { ttsMode: settings.provider, characterId: character.chaId })
                    } else {
                        throw new Error(language.ttsRequestFailed(language.ttsVoicevoxSynthesisTarget, getVoice.status))
                    }
                } else {
                    throw new Error(language.ttsRequestFailed(language.ttsVoicevoxAudioQueryTarget, query.status))
                }
                break
            }
            case 'gptsovits':{
                const config = settings.gptSoVits
                const baseUrl = config.url.trim().replace(/\/+$/, '')
                const referencePath = config.referenceAudioPath.trim()
                if (!baseUrl) throw new Error(language.ttsGptSoVitsServerRequired)
                if (config.useReferenceAudio && !referencePath) throw new Error(language.ttsGptSoVitsReferenceRequired)
                const body = {
                    text: text,
                    text_lang: config.textLanguage,
                    ref_audio_path: config.useReferenceAudio ? referencePath : '',
                    prompt_text: config.useReferenceAudio ? config.referenceAudioScript : '',
                    prompt_lang: config.useReferenceAudio ? config.referenceAudioLanguage : '',
                    top_p: config.topP,
                    temperature: config.temperature,
                    speed_factor: config.speed,
                    top_k: config.topK,
                    text_split_method: config.textSplitMethod,
                    parallel_infer: true,
                    media_type: 'wav',
                }
                const response = await globalFetch(`${baseUrl}/tts`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: body,
                    rawResponse: true,
                })
                if (response.ok) {
                    await playAudio(response.data.buffer, 'audio/wav', {
                        ttsMode: settings.provider,
                        characterId: character.chaId,
                    })
                } else {
                    const textBuffer: Uint8Array = response.data.buffer
                    throw new Error(Buffer.from(textBuffer).toString('utf-8'));
                }
                break;
            }
            case 'fishspeech':{
                const config = settings.fishAudio
                const apiKey = getTTSApiKey('fishspeech', '', settings)
                const referenceId = config.model._id.trim()
                if (!apiKey) throw new Error(language.ttsApiKeyMissing('Fish Audio'))
                if (!referenceId){
                    throw new Error(language.ttsVoiceNotSelected('Fish Audio'))
                }

                const body = {
                    text: text,
                    reference_id: referenceId,
                    chunk_length: config.chunkLength,
                    normalize: config.normalize,
                    format: 'mp3',
                    sample_rate: 44100,
                    mp3_bitrate: 128,
                    latency: 'normal',
                }

                const response = await globalFetch(`https://api.fish.audio/v1/tts`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                        'model': config.engine,
                    },
                    body: body,
                    rawResponse: true,
                })
                if (response.ok) {
                    await playAudio(response.data.buffer, 'audio/mpeg', { ttsMode: settings.provider, characterId: character.chaId })
                } else {
                    const textBuffer: Uint8Array = response.data.buffer
                    const text = Buffer.from(textBuffer).toString('utf-8')
                    throw new Error(text);
                }
                break;
            }
        }
    } catch (error) {
        notifyError(`${language.ttsErrorPrefix}: ${error}`)
    }
}



export function stopTTS(){
    stopBufferedTTS()
    if(speechSynthesis && SpeechSynthesisUtterance){
        speechSynthesis.cancel()
    }
}


export function getWebSpeechTTSVoices() {
    return speechSynthesis.getVoices().map(v => {
        return v.name
    })
}

export async function getElevenTTSVoices(apiKey = getTTSApiKey('elevenlabs')) {
    if (!apiKey) return []

    const data = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: {
            'xi-api-key': apiKey
        }
    })
    if (!data.ok) {
        throw new Error(language.ttsRequestFailed(language.ttsElevenLabsVoicesTarget, data.status))
    }
    const res = await data.json()
    return Array.isArray(res.voices) ? res.voices : []
}

export async function getVOICEVOXVoices(url = getTTSVoicevoxUrl()) {
    const baseUrl = url.trim().replace(/\/+$/, '')
    if (!baseUrl) throw new Error(language.ttsUrlNotConfigured('VOICEVOX'))

    const speakerData = await fetch(`${baseUrl}/speakers`)
    if (!speakerData.ok) {
        throw new Error(language.ttsRequestFailed(language.ttsVoicevoxSpeakersTarget, speakerData.status))
    }

    const speakerList = await speakerData.json()
    if (!Array.isArray(speakerList)) {
        throw new Error(language.ttsInvalidResponse(language.ttsVoicevoxSpeakersTarget))
    }
    const speakersInfo = speakerList.map((speaker) => {
      const styles = speaker.styles.map((style) => {
        return {name: style.name, id: `${style.id}`}
      })
      return {name: speaker.name, list: JSON.stringify(styles)}
    })
    speakersInfo.unshift({ name: language.none, list: ''})
    return speakersInfo;
}
