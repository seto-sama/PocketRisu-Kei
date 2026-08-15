import { getCurrentChat } from 'src/ts/storage/database.svelte'
import { compileModelPreset, type CompiledModelPreset } from 'src/ts/preset/runtime/compilePreset'
import { getPresetModelIdValue } from 'src/ts/preset/runtime/effectiveConfig'
import type { ModelPreset, RegistryTokenizer } from 'src/ts/preset/types'
import { resolveChatModelBinding } from '../request/modelPresetBinding'

export type GenerationModelMode = 'model' | 'submodel'

export interface GenerationModelMetadata {
    presetId: string
    name: string
    shortName: string
    internalId: string
    format: string
    provider: string
    tokenizer: RegistryTokenizer
    supportsPrefill: boolean
    streaming: boolean
    vision: boolean
    audioInput: boolean
    videoInput: boolean
}

export function getGenerationModelPreset(mode: GenerationModelMode = 'model'): ModelPreset | undefined {
    const binding = resolveChatModelBinding(getCurrentChat(), mode)
    return binding.kind === 'modelPreset' ? binding.preset : undefined
}

export function getGenerationModelRuntime(mode: GenerationModelMode = 'model'): CompiledModelPreset | undefined {
    const preset = getGenerationModelPreset(mode)
    return getModelPresetRuntime(preset)
}

export function getModelPresetRuntime(preset: ModelPreset | undefined): CompiledModelPreset | undefined {
    if(!preset) return undefined
    try {
        return compileModelPreset(preset)
    }
    catch {
        return undefined
    }
}

export function getModelPresetTokenizer(preset: ModelPreset | undefined): RegistryTokenizer {
    const configured = preset?.tokenizerOverride ?? preset?.profileSnapshot.recommendedTokenizer
    if(configured) return configured
    switch(preset?.profileSnapshot.adapterKind){
        case 'google-gemini': return 'gemma'
        case 'anthropic-messages':
        case 'amazon-bedrock': return 'claude'
        default: return 'tik'
    }
}

function stringifyModelId(value: unknown): string {
    if(typeof value === 'string') return value
    if(typeof value === 'number' || typeof value === 'boolean') return String(value)
    if(value === undefined || value === null) return ''
    try {
        return JSON.stringify(value)
    }
    catch {
        return String(value)
    }
}

export function getGenerationModelMetadata(mode: GenerationModelMode = 'model'): GenerationModelMetadata {
    const preset = getGenerationModelPreset(mode)
    return getModelPresetMetadata(preset)
}

export function getModelPresetMetadata(preset: ModelPreset | undefined): GenerationModelMetadata {
    const runtime = getModelPresetRuntime(preset)
    const adapterKind = runtime?.adapterKind ?? preset?.profileSnapshot.adapterKind ?? ''
    const internalId = stringifyModelId(runtime?.modelId ?? (preset ? getPresetModelIdValue(preset) : ''))
    const name = preset?.name ?? ''
    const customPrefill = preset?.userValues?.customFlag_hasPrefill === true
    return {
        presetId: preset?.id ?? '',
        name,
        shortName: name,
        internalId,
        format: adapterKind,
        provider: preset?.profileSnapshot.providerBaseId ?? '',
        tokenizer: getModelPresetTokenizer(preset),
        supportsPrefill: adapterKind === 'anthropic-messages' || customPrefill,
        streaming: runtime?.features.streaming ?? false,
        vision: runtime?.features.vision ?? false,
        audioInput: runtime?.features.audioInput ?? false,
        videoInput: runtime?.features.videoInput ?? false,
    }
}

export function getGenerationModelString(name?: string): string {
    return name ?? getGenerationModelMetadata('model').name
}
