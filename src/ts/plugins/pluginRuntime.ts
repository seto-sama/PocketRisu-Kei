import type { OpenAIChat } from '../process/index.svelte'
import type { RevenantGenerationRequest } from '../process/revenant'
import type { LLMExecutionPolicy } from '../network/transportTypes'

/** Host-only metadata attached to provider requests before they enter a plugin sandbox. */
export const pluginProviderRequestContextKey: unique symbol = Symbol('pluginProviderRequestContext')

export type PluginProviderRequestContext = {
    chatId?: string
    generationRequest?: RevenantGenerationRequest
    llmExecutionPolicy?: LLMExecutionPolicy
    interceptor: string
}

export type PluginProviderArgument = {
    prompt_chat: OpenAIChat[]
    frequency_penalty: number
    min_p: number
    presence_penalty: number
    repetition_penalty: number
    top_k: number
    top_p: number
    temperature: number
    mode: string
    max_tokens: number
    [pluginProviderRequestContextKey]?: PluginProviderRequestContext
}

export type PluginProviderFunction = (
    arg: PluginProviderArgument,
    abortSignal?: AbortSignal,
) => Promise<{ success: boolean, content: string | ReadableStream<string> }>

export type EditFunction = (content: string) => string | null | undefined | Promise<string | null | undefined>
export type ReplacerFunction = (content: OpenAIChat[], type: string) => OpenAIChat[] | Promise<OpenAIChat[]>
type AfterRequestReplacerFunction = (content: string, type: string) => string | Promise<string>

type ChatOutputListenerArg = {
    char: any
    chat: any
    characterIndex: number
    chatIndex: number
    messageIndex: number
}
export type ChatOutputListener = (arg: ChatOutputListenerArg) => void | Promise<void>

/** Registrations shared by API 3.0 plugins and the host request/script pipelines. */
export const pluginRuntime = {
    providers: new Map<string, PluginProviderFunction>(),
    editdisplay: new Set<EditFunction>(),
    editoutput: new Set<EditFunction>(),
    editprocess: new Set<EditFunction>(),
    editinput: new Set<EditFunction>(),
    replacerbeforeRequest: new Set<ReplacerFunction>(),
    replacerafterRequest: new Set<AfterRequestReplacerFunction>(),
    chatOutput: new Set<ChatOutputListener>(),
}
