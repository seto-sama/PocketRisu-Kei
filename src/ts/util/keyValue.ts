export function parseKeyValue(template:string){
    try {
        if(!template){
            return []
        }

        const keyValue:[string, string][] = []

        for(const line of template.split('\n')){
            const [key, value] = line.split('=')
            if(key && value){
                keyValue.push([key, value])
            }
        }

        return keyValue
    } catch (error) {
        return []
    }
}
