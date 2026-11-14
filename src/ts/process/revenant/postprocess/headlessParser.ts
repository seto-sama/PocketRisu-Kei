import { getChatBoundPersona } from '../../../chatBindingState'
import { pocketKeiVer } from '../../../version'
import { registerCBS, type RegisterCallback } from '../../../cbs'
import { calculateExpression } from '../../calculate'
import {
    dateTimeFormat,
    makeArray,
    parseArray,
    parseCbs,
    parseDict,
    type CbsParserArg,
    type CbsParserEnv,
} from '../../../parser/cbsCore'
import { modelPresetSupportsPrefill } from '../../../preset/adapter/openaiCompatible'
import type { ModelPreset } from '../../../preset/types'
import type { Chat, character, Database, RisuPersona } from '../../../storage/database.svelte'
import { pickHashRand } from '../../../util/hashRand'
import { parseKeyValue } from '../../../util/keyValue'
import type { RevenantPostprocessRecipe } from '../types'

type TemplateState = {
    recipe: RevenantPostprocessRecipe
    character: character
    chat: Chat
    database: Record<string, any>
    matchers: Map<string, RegisterCallback>
}

// Mirrors getChatVarOf/getGlobalChatVar from the browser parser so server
// rendering and Lua resolve variables exactly like the client.
export function revenantChatVariable(recipe: RevenantPostprocessRecipe, chat: Chat, key: string): string {
    const value = chat.scriptstate?.[`$${key}`]
    if (value !== undefined && value !== null) return value.toString()
    const defaults = parseKeyValue(recipe.character.defaultVariables)
        .concat(parseKeyValue(recipe.database.templateDefaultVariables))
    return defaults.find(entry => entry[0] === key)?.[1] ?? ''
}

export function revenantGlobalVariable(recipe: RevenantPostprocessRecipe, key: string): string {
    return recipe.database.globalChatVariables?.[key] ?? ''
}

const chatVariable = (state: TemplateState, key: string) => revenantChatVariable(state.recipe, state.chat, key)
const globalChatVariable = (state: TemplateState, key: string) => revenantGlobalVariable(state.recipe, key)

function setChatVariable(state: TemplateState, key: string, value: string): void {
    state.chat.scriptstate ??= {}
    state.chat.scriptstate[`$${key}`] = value
}

function calculateTemplate(state: TemplateState, text: string): number {
    return calculateExpression(text, {
        chat: key => chatVariable(state, key),
        global: key => globalChatVariable(state, key),
    })
}

function selectedPersona(state: TemplateState): any {
    const personas = (state.recipe.database.personas ?? []) as RisuPersona[]
    return getChatBoundPersona({
        personas,
        showPersonaInSidebar: state.recipe.database.showPersonaInSidebar,
    }, state.chat) ?? personas[state.recipe.database.selectedPersona ?? 0]
}

function renderTemplate(input: string, state: TemplateState, arg: CbsParserArg = {}): string {
    const env: CbsParserEnv = {
        matchers: state.matchers,
        calcString: text => calculateTemplate(state, text),
        getChatVar: key => chatVariable(state, key),
        getGlobalChatVar: key => globalChatVariable(state, key),
        getDatabase: () => state.database as Database,
        getSelectedCharacter: () => state.character,
    }
    return parseCbs(input, arg, env)
}

function createState(recipe: RevenantPostprocessRecipe, chat: Chat): TemplateState {
    // CBS only reads these, so shallow copies suffice.
    const character = { ...recipe.character, chats: [chat] }
    const database = {
        ...recipe.database,
        characters: [character],
        selectedPersona: recipe.database.selectedPersona ?? 0,
    }
    const state: TemplateState = {
        recipe,
        character,
        chat,
        database,
        matchers: new Map(),
    }
    const persona = () => selectedPersona(state)
    registerCBS({
        registerFunction: definition => {
            if (definition.callback === 'doc_only') return
            for (const name of [definition.name, ...definition.alias]) {
                state.matchers.set(name, definition.callback)
            }
        },
        getDatabase: () => state.database as any,
        getChatPage: () => 0,
        getUserName: () => persona()?.name ?? recipe.database.username ?? 'User',
        getTriggerId: () => null,
        getPersonaPrompt: () => persona()?.personaPrompt ?? recipe.database.personaPrompt ?? '',
        risuChatParser: (text, arg) => renderTemplate(text, state, arg),
        makeArray,
        structuredClone: value => structuredClone(value),
        parseArray,
        parseDict,
        getChatVar: key => chatVariable(state, key),
        setChatVar: (key, value) => setChatVariable(state, key, value),
        getGlobalChatVar: key => globalChatVariable(state, key),
        calcString: text => calculateTemplate(state, text),
        dateTimeFormat,
        getModules: () => recipe.modules as any[],
        getModuleLorebooks: () => (recipe.modules as any[]).flatMap(module => module?.lorebook ?? []),
        pickHashRand,
        getSelectedCharID: () => 0,
        getGenerationModelString: () => {
            const name = (recipe.modelPreset as { name?: unknown } | null)?.name
            return typeof name === 'string' ? name : ''
        },
        getGenerationModelMetadata: mode => {
            const rawPreset = mode === 'submodel'
                ? recipe.auxProviders?.submodel?.modelPreset
                : recipe.modelPreset
            const preset = rawPreset as {
                id?: unknown
                name?: unknown
                tokenizerOverride?: unknown
                profileSnapshot?: {
                    adapterKind?: unknown
                    providerBaseId?: unknown
                    modelId?: unknown
                    recommendedTokenizer?: unknown
                }
            } | null
            const stringValue = (value: unknown) => typeof value === 'string' ? value : ''
            const name = stringValue(preset?.name)
            return {
                presetId: stringValue(preset?.id),
                name,
                shortName: name,
                internalId: stringValue(preset?.profileSnapshot?.modelId),
                format: stringValue(preset?.profileSnapshot?.adapterKind),
                provider: stringValue(preset?.profileSnapshot?.providerBaseId),
                tokenizer: (stringValue(preset?.tokenizerOverride)
                    || stringValue(preset?.profileSnapshot?.recommendedTokenizer)
                    || 'tik') as any,
                supportsPrefill: preset?.profileSnapshot
                    ? modelPresetSupportsPrefill(rawPreset as ModelPreset)
                    : false,
                streaming: false,
                vision: false,
                audioInput: false,
                videoInput: false,
            }
        },
        callInternalFunction: () => '',
        isNodeServer: true,
        isMobile: false,
        pocketKeiVer,
    })
    return state
}

export function renderRevenantTemplate(
    input: string,
    recipe: RevenantPostprocessRecipe,
    chat: Chat = structuredClone(recipe.chat),
    arg: CbsParserArg = {},
): { text: string, chat: Chat } {
    const state = createState(recipe, chat)
    return {
        text: renderTemplate(input, state, arg),
        chat: state.chat,
    }
}
