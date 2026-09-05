import { risuChatParser } from './parser.svelte'
import { parseChatMLCore } from './chatMLCore'

export function parseChatML(data: string) {
  return parseChatMLCore(data, risuChatParser)
}
