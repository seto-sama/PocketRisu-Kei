import { risuChatParser } from '../parser/parser.svelte'
import type { character } from '../storage/database.svelte'
import { tokenize } from '../tokenizer'

interface LorebookPromptCandidate {
    prompt: string
    priority: number
    order: number
}

export type BudgetedLorebookPrompt<T extends LorebookPromptCandidate> = T & {
    tokens: number
}

/** Render lorebook text exactly as it will be exposed to the prompt pipeline. */
export function renderLorebookContent(content: string, char: character): string {
    return risuChatParser(content, { chara: char })
}

/**
 * Select active lorebook prompts using their rendered CBS output for budgeting.
 *
 * Activation and recursive matching remain the caller's responsibility. This
 * function owns the later prompt concern: priority, rendered token cost, token
 * budget, and final insertion order.
 */
export async function selectLorebookPromptsWithinBudget<T extends LorebookPromptCandidate>(
    candidates: readonly T[],
    tokenBudget: number,
    char: character,
): Promise<BudgetedLorebookPrompt<T>[]> {
    const prioritized = [...candidates].sort((a, b) => b.priority - a.priority)
    const selected: BudgetedLorebookPrompt<T>[] = []
    let usedTokens = 0

    for(const candidate of prioritized){
        const rendered = renderLorebookContent(candidate.prompt, char)
        const tokens = await tokenize(rendered)

        if(usedTokens + tokens <= tokenBudget){
            usedTokens += tokens
            selected.push({ ...candidate, tokens })
        }
    }

    return selected.sort((a, b) => b.order - a.order)
}
