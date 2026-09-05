import type { OpenAIChat } from '../process/index.svelte'

export function parseChatMLCore(data: string, render: (text: string) => string): OpenAIChat[] | null {
  const starter = '<|im_start|>'
  const seperator = '<|im_sep|>'
  const ender = '<|im_end|>'

  const trimedData = data.trim()
  if (!trimedData.startsWith(starter)) {
    return null
  }

  return trimedData
    .split(starter)
    .filter((f) => f !== '')
    .map((v) => {
      let role: 'system' | 'user' | 'assistant' = 'user'
      //default separators
      if (v.startsWith('user' + seperator)) {
        role = 'user'
        v = v.substring(4 + seperator.length)
      } else if (v.startsWith('system' + seperator)) {
        role = 'system'
        v = v.substring(6 + seperator.length)
      } else if (v.startsWith('assistant' + seperator)) {
        role = 'assistant'
        v = v.substring(9 + seperator.length)
      }
      //space/newline separators
      else if (v.startsWith('user ') || v.startsWith('user\n')) {
        role = 'user'
        v = v.substring(5)
      } else if (v.startsWith('system ') || v.startsWith('system\n')) {
        role = 'system'
        v = v.substring(7)
      } else if (v.startsWith('assistant ') || v.startsWith('assistant\n')) {
        role = 'assistant'
        v = v.substring(10)
      }

      v = v.trim()
      v = v.replaceAll(ender, '')

      let thoughts: string[] = []
      v = v.replace(/<Thoughts>(.+)<\/Thoughts>/gms, (_, p1) => {
        thoughts.push(p1)
        return ''
      })

      return {
        role: role,
        content: render(v),
        thoughts: thoughts,
      }
    })
}
