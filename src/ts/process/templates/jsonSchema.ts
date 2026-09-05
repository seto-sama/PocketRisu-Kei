import { convertInterfaceToSchemaCore } from './jsonSchemaCore'
import { risuChatParser } from "src/ts/parser/parser.svelte"
import { getDatabase } from "src/ts/storage/database.svelte"
import { jsonOutputTrimmer } from "src/ts/util"

export function convertInterfaceToSchema(int:string){
    return convertInterfaceToSchemaCore(int, risuChatParser)
}

export function getOpenAIJSONSchema(schema?:string){
    const db = getDatabase()
    return {
        "name": "format",
        "strict": db.strictJsonSchema,
        "schema": convertInterfaceToSchema(schema ?? db.jsonSchema)
    }
}


export function getGeneralJSONSchema(schema?:string, excludes:string[] = []){
    const db = getDatabase()

    function process(data:any){
        const keys = Object.keys(data)
        for(const key of keys){
            if(excludes.includes(key)){
                delete data[key]
            }
            if(typeof data[key] === 'object'){
                data[key] = process(data[key])
            }
        }
        return data
    }

    const d = convertInterfaceToSchema(schema ?? db.jsonSchema)
    return process(d)
}

export function extractJSON(data:string, format:string){
    const extract = (data:any, format:string) => {
        try {
            if(data === undefined || data === null){
                return ''
            }

            const fp = format.split('.')
            const current = data[fp[0]]

            if(current === undefined){
                return ''
            }
            else if(fp.length === 1){
                return `${current ?? ''}`
            }
            else if(typeof current === 'object'){
                return extractJSON(current, fp.slice(1).join('.'))
            }
            else if(Array.isArray(current)){
                const index = parseInt(fp[1])
                return extractJSON(current[index], fp.slice(1).join('.'))
            }
            else{
                return `${current ?? ''}`
            }   
        } catch (error) {
            return ''
        }
    }
    try {
        format = risuChatParser(format)
        data = data.trim()
        if(data.startsWith('{')){
            return extract(JSON.parse(jsonOutputTrimmer(data)), format)
        }   
    } catch (error) {}
    return data
}