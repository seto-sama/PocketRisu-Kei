import type { character } from "../storage/database.svelte";

export function runInlayScreen(char:character, data:string):{text:string, promise?:Promise<string>} {
    if(char.inlayViewScreen){      
        if(char.viewScreen === 'emotion'){
            return {text: data.replace(/<Emotion="(.+?)">/gi, '{{emotion::$1}}')}
        }
    }

    return {text: data}
}

export function updateInlayScreen(char:character):character {
    const previousInstructions = char.newGenData?.emotionInstructions
    char.newGenData = {
        emotionInstructions: previousInstructions || `You must always output the character's emotional image as a command at the end of a conversation. The command must be selected from a given list, and it's better to have variety than to repeat images used in previous chats. Use one image, depending on the character's emotion. See the list below. Form: <Emotion="<image command>"> Example: <Emotion="Agree"> List of commands: {{slot}}`,
    }
    if(char.viewScreen !== 'emotion') char.inlayViewScreen = false
    return char
}
