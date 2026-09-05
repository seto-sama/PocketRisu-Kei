import type { Database } from 'src/ts/storage/database.svelte'

export type TemplateWarning =
    | { kind: 'missing' | 'multiple'; item: 'main' | 'globalNote' | 'description' | 'lorebook' }
    | { kind: 'missingChatEnd' }
    | { kind: 'unconnectedChatRanges'; ranges: number[] }

export function templateCheck(db:Database){

    const temp = db.promptTemplate
    let mainPrompts = 0
    let notePrompts = 0
    let endRanges:number[] = []
    let startRanges:number[] = []
    let hasDescription = false
    let hasLorebook = false
    let reachEnd = false

    for(let i=0;i<temp.length;i++){
        const c = temp[i]
        if(c.type === 'jailbreak' || c.type === 'plain'){
            if(c.type2 === 'globalNote'){
                notePrompts++
            }
            if(c.type2 === 'main'){
                mainPrompts++
            }
        }
        else if(c.type === 'chat'){
            if(c.rangeStart !== -1000){
                if(c.rangeStart !== 0){
                    startRanges.push(c.rangeStart)
                }
                if(c.rangeEnd !== 'end'){
                    endRanges.push(c.rangeEnd)
                }
                else{
                    reachEnd = true
                }
            }
        }
        else if(c.type === 'description'){
            hasDescription = true
        }
        else if(c.type === 'lorebook'){
            hasLorebook = true
        }
    }

    let warnings:TemplateWarning[] = []

    let unresolvedRanges = startRanges.filter(x => !endRanges.includes(x)).concat(endRanges.filter(x => !startRanges.includes(x)))

    if(mainPrompts === 0){
        warnings.push({ kind: 'missing', item: 'main' })
    }
    if(mainPrompts > 1){
        warnings.push({ kind: 'multiple', item: 'main' })
    }
    if(notePrompts === 0){
        warnings.push({ kind: 'missing', item: 'globalNote' })
    }
    if(notePrompts > 1){
        warnings.push({ kind: 'multiple', item: 'globalNote' })
    }
    if(!hasDescription){
        warnings.push({ kind: 'missing', item: 'description' })
    }
    if(!hasLorebook){
        warnings.push({ kind: 'missing', item: 'lorebook' })
    }
    if(!reachEnd){
        warnings.push({ kind: 'missingChatEnd' })
    }

    if(unresolvedRanges.length > 0){
        warnings.push({ kind: 'unconnectedChatRanges', ranges: unresolvedRanges })
    }

    return warnings

}
