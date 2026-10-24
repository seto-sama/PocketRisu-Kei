import { risuChatParser } from '../parser/parser.svelte'
import type { character } from '../storage/database.svelte'
import { tokenize } from '../tokenizer'

interface LorebookPromptCandidate {
    prompt: string
    priority: number
    order: number
}

type BudgetedLorebookPrompt<T extends LorebookPromptCandidate> = T & {
    tokens: number
}

export function renderLorebookContent(content: string, char: character): string {
    return risuChatParser(content, { chara: char })
}

// Budget CBS output so hidden template text does not consume tokens.
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
