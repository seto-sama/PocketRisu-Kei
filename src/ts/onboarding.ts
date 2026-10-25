import type { character, CharacterOnboarding, Chat, OnboardingQuestion } from './storage/database.svelte'
import type { ChatWorkingCopyTarget } from './storage/chatWorkingCopy'
import { createEntityId } from './id'
import { getChatVarOf, setChatVarOf } from './parser/chatVar.svelte'
import { commitTriggerChat, resolveTriggerOrigin } from './process/triggerOrigin'
import { ReloadGUIPointer } from './stores.svelte'

// Original RisuAI onboarding (450a598aa), adapted to Kei's chat selection and
// target-chat commits.

export const onboardingVarNameAttr = 'risu-change-var-name'
export const onboardingVarValueAttr = 'risu-change-var-value'

export function createOnboarding(): CharacterOnboarding {
    return {
        enabled: true,
        mode: 'form',
        title: '',
        description: '',
        questions: [],
        html: '',
        floatingButton: false,
    }
}

export function createOnboardingQuestion(): OnboardingQuestion {
    return {
        id: createEntityId(),
        title: '',
        description: '',
        type: 'single',
        varName: '',
        required: false,
        options: [{ label: '', value: '' }],
    }
}

/** The character's onboarding, or null when it is disabled or has nothing to show. */
export function getActiveOnboarding(char: character | undefined): CharacterOnboarding | null {
    const onboarding = char?.onboarding
    if (!onboarding?.enabled) {
        return null
    }
    if (onboarding.mode === 'html') {
        return /\S/.test(onboarding.html ?? '') ? onboarding : null
    }
    return onboarding.questions?.length > 0 ? onboarding : null
}

/** Reads a chat variable, including default variables, or undefined when it has no value. */
export function readOnboardingVar(char: character, chat: Chat, varName: string): string | undefined {
    const value = getChatVarOf(chat, varName, char.defaultVariables)
    return value === '' ? undefined : value
}

/** Multiple-choice answers are stored as a JSON array, the same format CBS array functions use. */
export function parseMultipleValue(value: string | undefined): string[] {
    if (!value) {
        return []
    }
    try {
        const parsed = JSON.parse(value)
        if (Array.isArray(parsed)) {
            return parsed.map((v) => String(v))
        }
    } catch {}
    return [value]
}

export function stringifyMultipleValue(values: string[]): string {
    return JSON.stringify(values)
}

export function getOptionValue(option: { label: string, value: string }): string {
    return option.value !== '' ? option.value : option.label
}

export function readFormAnswers(char: character, chat: Chat, questions: OnboardingQuestion[]): Record<string, string> {
    const answers: Record<string, string> = {}
    for (const question of questions) {
        if (!question.varName) {
            continue
        }
        const value = readOnboardingVar(char, chat, question.varName)
        if (value !== undefined) {
            answers[question.varName] = value
        }
    }
    return answers
}

export function isQuestionAnswered(question: OnboardingQuestion, answers: Record<string, string>): boolean {
    const value = answers[question.varName]
    if (question.type === 'multiple') {
        return parseMultipleValue(value).length > 0
    }
    return !!value && value.trim() !== ''
}

/**
 * Writes the answers to the chat the onboarding was opened for and marks it
 * done. Skipping passes no answers. Returns false when that chat is gone.
 */
export async function applyOnboardingAnswers(target: ChatWorkingCopyTarget, answers: Record<string, string>): Promise<boolean> {
    const origin = resolveTriggerOrigin(target)
    if (!origin || origin.chat._placeholder) {
        return false
    }
    const chat: Chat = { ...origin.chat, scriptstate: { ...origin.chat.scriptstate }, onboardingDone: true }
    const entries = Object.entries(answers).filter(([varName]) => varName)
    for (const [varName, value] of entries) {
        setChatVarOf(chat, varName, value)
    }
    if (!await commitTriggerChat(target, chat)) {
        return false
    }
    // Rendered messages and background HTML may read the new variables.
    if (entries.length > 0) {
        ReloadGUIPointer.update((value) => value + 1)
    }
    return true
}

/** Coerces onboarding data from an imported card into a well-formed shape, or undefined. */
export function normalizeOnboarding(raw: unknown): CharacterOnboarding | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined
    }
    const data = raw as Partial<CharacterOnboarding>
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    const questions = Array.isArray(data.questions) ? data.questions : []
    return {
        enabled: data.enabled === true,
        mode: data.mode === 'html' ? 'html' : 'form',
        title: str(data.title),
        description: str(data.description),
        html: str(data.html),
        floatingButton: data.floatingButton === true,
        questions: questions.filter((q) => q && typeof q === 'object').map((q) => ({
            id: str(q.id) || createEntityId(),
            title: str(q.title),
            description: str(q.description),
            type: q.type === 'multiple' || q.type === 'text' ? q.type : 'single',
            varName: str(q.varName),
            required: q.required === true,
            placeholder: str(q.placeholder),
            options: (Array.isArray(q.options) ? q.options : [])
                .filter((o) => o && typeof o === 'object')
                .map((o) => ({ label: str(o.label), value: str(o.value) })),
        })),
    }
}
