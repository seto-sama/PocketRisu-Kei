import type { TriggerV2Effect } from './triggerV2Core'

export type TriggerActionKind =
    | 'log'
    | 'prompt.append'
    | 'prompt.stop'
    | 'chat.resend'
    | 'trigger.run'
    | 'ui.command'
    | 'ui.alert'
    | 'ui.input'
    | 'ui.select'
    | 'ui.reload-display'
    | 'ui.reload-chat'
    | 'utility.wait'
    | 'utility.similarity'
    | 'utility.tokenize'
    | 'image.generate'
    | 'provider.llm'

export type TriggerTypedAction = {
    kind: TriggerActionKind
    payload: Record<string, unknown>
    outputVar?: string
    permission?: 'lowLevel'
}

type ActionContext = {
    read: (effect: TriggerV2Effect, field?: string, typeField?: string) => string
    render: (value: unknown) => string
    outputVar: (effect: TriggerV2Effect) => string
}

export function buildTriggerAction(
    effect: TriggerV2Effect,
    context: ActionContext,
): TriggerTypedAction | undefined {
    const read = (field = 'value', typeField = `${field}Type`) => context.read(effect, field, typeField)
    const outputVar = () => context.outputVar(effect)
    switch (effect.type) {
        case 'v2ConsoleLog':
            return { kind: 'log', payload: { value: read('source', 'sourceType') } }
        case 'v2SystemPrompt':
            return { kind: 'prompt.append', payload: { value: read(), location: effect.location } }
        case 'v2StopPromptSending':
            return { kind: 'prompt.stop', payload: {} }
        case 'v2SendAIprompt':
            return { kind: 'chat.resend', payload: {}, permission: 'lowLevel' }
        case 'v2RunTrigger':
            return { kind: 'trigger.run', payload: { target: context.render(effect.target) } }
        case 'v2Command':
            return { kind: 'ui.command', payload: { command: read() } }
        case 'v2ImgGen':
            return {
                kind: 'image.generate',
                payload: { prompt: read(), negativePrompt: read('negValue', 'negValueType') },
                outputVar: outputVar(),
                permission: 'lowLevel',
            }
        case 'v2CheckSimilarity':
            return {
                kind: 'utility.similarity',
                payload: { source: read('source', 'sourceType'), values: read().split('§') },
                outputVar: outputVar(),
                permission: 'lowLevel',
            }
        case 'v2RunLLM':
            return {
                kind: 'provider.llm',
                payload: {
                    prompt: read(),
                    mode: effect.model === 'submodel' ? 'submodel' : 'model',
                    streaming: effect.streaming === true,
                },
                outputVar: outputVar(),
                permission: 'lowLevel',
            }
        case 'v2ShowAlert':
            return { kind: 'ui.alert', payload: { message: read(), level: 'normal' } }
        case 'v2GetAlertInput':
            return {
                kind: 'ui.input',
                payload: { message: read('display', 'displayType') },
                outputVar: outputVar(),
            }
        case 'v2GetAlertSelect':
            return {
                kind: 'ui.select',
                payload: {
                    message: read('display', 'displayType'),
                    options: read().split('|'),
                },
                outputVar: outputVar(),
            }
        case 'v2UpdateGUI':
            return { kind: 'ui.reload-display', payload: {} }
        case 'v2UpdateChatAt':
            return { kind: 'ui.reload-chat', payload: { index: Number(context.render(effect.index)) || 0 } }
        case 'v2Wait':
            return { kind: 'utility.wait', payload: { durationMs: Math.max(0, Number(read()) || 0) * 1000 } }
        case 'v2Tokenize':
            return { kind: 'utility.tokenize', payload: { text: read() }, outputVar: outputVar() }
        default:
            return undefined
    }
}

export function canExecuteTriggerAction(action: TriggerTypedAction, lowLevelAccess: boolean): boolean {
    return action.permission !== 'lowLevel' || lowLevelAccess
}

export function normalizeTriggerActionResult(action: TriggerTypedAction, result: unknown): string {
    if (action.kind === 'provider.llm') {
        if (result && typeof result === 'object') {
            const value = result as { success?: boolean, result?: unknown }
            return value.success === false ? 'null' : String(value.result ?? 'null')
        }
        return String(result ?? 'null')
    }
    if (action.kind === 'utility.similarity' && Array.isArray(result)) return result.join('§')
    return String(result ?? 'null')
}
