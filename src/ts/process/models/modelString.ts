import { getDatabase, getCurrentChat } from "src/ts/storage/database.svelte";

export function getGenerationModelString(name?:string){
    const db = getDatabase()
    // When no explicit model name is passed, reflect the effective main
    // ModelPreset. Old per-chat model-mode flags are intentionally ignored.
    if(name === undefined){
        const chat = getCurrentChat()
        const boundMainId = chat?.modelBinding?.main ?? db.defaultModelBinding?.main
        if(boundMainId){
            const preset = db.modelPresets?.find(p => p.id === boundMainId)
            if(preset) return preset.name
        }
    }
    switch (name ?? db.aiModel){
        case 'reverse_proxy':
            return 'custom-' + (db.reverseProxyOobaMode ? 'ooba' : db.customProxyRequestModel)
        case 'openrouter':
            return 'openrouter-' + db.openrouterRequestModel
        case 'nanogpt': {
            const modelLabel = db.nanogptRequestModelName || db.nanogptRequestModel
            return 'NanoGPT ' + modelLabel + (db.nanogptUseSubscriptionEndpoint ? ' [SUB]' : '')
        }
        default:
            return name ?? db.aiModel
    }
}
