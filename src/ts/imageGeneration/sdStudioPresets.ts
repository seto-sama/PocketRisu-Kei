import { joinImagePrompts } from './stylePresets'

export interface SDStudioPrompt {
    name: string
    prompt: string
}

export function parseSDStudioPresets(json: string): SDStudioPrompt[] {
    const project = JSON.parse(json)
    if (!project?.scenes || typeof project.scenes !== 'object' || Array.isArray(project.scenes)) {
        throw new Error('SDStudio project has no scenes')
    }
    const prompts: SDStudioPrompt[] = []
    for (const [name, scene] of Object.entries(project.scenes)) {
        const { slots } = scene as { slots?: unknown }
        if (!Array.isArray(slots)) continue
        let combinations = ['']
        for (const column of slots) {
            if (!Array.isArray(column)) throw new Error('Invalid SDStudio prompt slots')
            const candidates = column.filter(slot => slot?.enabled !== false).map(slot => {
                if (typeof slot?.prompt !== 'string') throw new Error('Invalid SDStudio prompt')
                // Piece references require a separate SDStudio library, unavailable in a single project file.
                return slot.prompt.replace(/<[^<>.\r\n]+\.[^<>.\r\n]+>/g, '')
                    .split(',').map((tag: string) => tag.trim()).filter(Boolean).join(', ')
            })
            combinations = combinations.flatMap(prefix => candidates.map(prompt => joinImagePrompts(prefix, prompt)))
        }
        for (const prompt of combinations) {
            if (prompt) prompts.push({ name, prompt })
        }
    }
    if (!prompts.length) throw new Error('SDStudio project has no enabled prompts')
    return prompts
}
