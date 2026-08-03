import { getChatVar, getGlobalChatVar } from '../parser/chatVar.svelte';
import { calculateExpression } from './calculate';

export function calcString(text:string) {
    return calculateExpression(text, { chat: getChatVar, global: getGlobalChatVar })
}
