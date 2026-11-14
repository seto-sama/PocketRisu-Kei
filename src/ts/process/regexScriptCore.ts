import type { Chat, customscript } from '../storage/database.svelte'
import { setMessageContent } from '../storage/messageContent'

// Regex script execution shared by the browser (scripts.ts) and the server
// postprocess pipeline so both apply scripts identically.

export type ScriptMode = 'editinput'|'editoutput'|'editprocess'|'editdisplay'

export type RegexScriptEnv = {
    chatID: number
    parse: (text: string) => string
    // Chat holding message `chatID` and its owner, used by inject and repeat_back.
    getTarget: () => {
        chat: Chat
        character: { firstMessage: string, alternateGreetings: string[] }
    } | undefined
    onError: (error: unknown) => void
}

type pScript = {
    script: customscript,
    order: number
    actions: string[]
}

const dreg = /{{data}}/g

export function applyRegexScripts(data: string, scripts: customscript[], mode: ScriptMode, env: RegexScriptEnv): string {
    const { chatID, parse } = env

    function executeScript(pscript:pScript){
        const script = pscript.script

        if(script.in === ''){
            return
        }

        if(script.type === mode){

            let outScript2 = script.out.replaceAll("$n", "\n")
            let outScript = outScript2.replace(dreg, "$&")
            let flag = 'g'
            if(script.ableFlag){
                flag = script.flag || 'g'
            }
            if(outScript.startsWith('@@move_top') || outScript.startsWith('@@move_bottom') || pscript.actions.includes('move_top') || pscript.actions.includes('move_bottom')){
                // Positioning directives are applied to one match at a time.
                flag = flag.replace('g', '')
            }
            if(outScript.endsWith('>') && !pscript.actions.includes('no_end_nl')){
                outScript += '\n'
            }
            flag = flag.trim().replace(/[^dgimsuvy]/g, '')

            flag = flag.split('').filter((v, i, a) => a.indexOf(v) === i).join('')

            if(flag.length === 0){
                flag = 'u'
            }

            let input = script.in
            if(pscript.actions.includes('cbs')){
                input = parse(input)
            }

            const reg = new RegExp(input, flag)
            if(outScript.startsWith('@@') || pscript.actions.length > 0){
                if(reg.test(data)){
                    if(outScript.startsWith('@@emo ')){
                        // Legacy emotion-display directive; kept as a no-op so it never leaks into text.
                    }
                    else if((outScript.startsWith('@@inject') || pscript.actions.includes('inject')) && chatID !== -1){
                        const targetMessage = env.getTarget()?.chat?.message?.[chatID]
                        // Chat sync may replace this message while scripts await;
                        // skip injection if its original index no longer exists.
                        if(targetMessage) setMessageContent(targetMessage, data)
                        data = data.replace(reg, "")
                    }
                    else if(
                        outScript.startsWith('@@move_top') || outScript.startsWith('@@move_bottom') ||
                        pscript.actions.includes('move_top') || pscript.actions.includes('move_bottom')
                    ){
                        const isGlobal = flag.includes('g')
                        const matchAll = isGlobal ? data.matchAll(reg) : [data.match(reg)]
                        data = data.replace(reg, "")
                        for(const matched of matchAll){
                            if(matched){
                                const inData = matched[0]
                                let out = outScript.replace('@@move_top ', '').replace('@@move_bottom ', '')
                                    .replace(/(?<!\$)\$[0-9]+/g, (v)=>{
                                        const index = parseInt(v.substring(1))
                                        if(index < matched.length){
                                            return matched[index]
                                        }
                                        return v
                                    })
                                    .replace(/\$\&/g, inData)
                                    .replace(/(?<!\$)\$<([^>]+)>/g, (v) => {
                                        const groupName = parseInt(v.substring(2, v.length - 1))
                                        if(matched.groups && matched.groups[groupName]){
                                            return matched.groups[groupName]
                                        }
                                        return v
                                    })
                                if(outScript.startsWith('@@move_top') || pscript.actions.includes('move_top')){
                                    data = out + '\n' +data
                                }
                                else{
                                    data = data + '\n' + out
                                }
                            }
                        }
                        data = parse(data)
                    }
                    else{
                        data = parse(data.replace(reg, outScript))
                    }
                }
                else{
                    if((outScript.startsWith('@@repeat_back') || pscript.actions.includes('repeat_back'))  && chatID !== -1){
                        const v = outScript.split(' ', 2)[1]
                        const { chat, character } = env.getTarget()
                        let lastChat = chat.fmIndex === -1 ? character.firstMessage : character.alternateGreetings[chat.fmIndex]
                        let pointer = chatID - 1
                        while(pointer >= 0){
                            if(chat.message[pointer].role === chat.message[chatID].role){
                                lastChat = chat.message[pointer].data
                                break
                            }
                            pointer--
                        }

                        const r = lastChat.match(reg)
                        if(!v){
                            data = data + r[0]
                        }
                        else if(r[0]){
                            switch(v){
                                case 'end':
                                    data = data + r[0]
                                    break
                                case 'start':
                                    data = r[0] + data
                                    break
                                case 'end_nl':
                                    data = data + "\n" + r[0]
                                    break
                                case 'start_nl':
                                    data = r[0] + "\n" + data
                                    break
                            }

                        }
                    }
                }
            }
            else{
                data = parse(data.replace(reg, outScript))
            }
        }
    }

    let parsedScripts:pScript[] = []
    let orderChanged = false
    for (const script of scripts){
        if(script.ableFlag && script.flag?.includes('<')){
            const rregex = /<(.+?)>/g
            const scriptData = structuredClone(script)
            let order = 0
            const actions:string[] = []
            scriptData.flag = scriptData.flag?.replace(rregex, (v:string, p1:string) => {
                const meta = p1.split(',').map((v) => v.trim())
                for(const m of meta){
                    if(m.startsWith('order ')){
                        order = parseInt(m.substring(6))
                        orderChanged = true
                    }
                    else{
                        actions.push(m)
                    }
                }

                return ''
            })
            parsedScripts.push({
                script: scriptData,
                order,
                actions
            })
            continue
        }
        parsedScripts.push({
            script,
            order: 0,
            actions: []
        })
    }

    if(orderChanged){
        parsedScripts.sort((a, b) => b.order - a.order) //sort by order
    }
    for (const script of parsedScripts){
        try {
            executeScript(script)
        } catch (error) {
            env.onError(error)
        }
    }
    return data
}
