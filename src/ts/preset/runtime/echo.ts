import type { ModelPreset } from '../types'
import echoProfile from '../registry/bundled/profiles/developer/echo.json'
import { getEffectivePresetValue } from './effectiveConfig'

export function buildEchoRequest(
    preset: ModelPreset,
    stream: boolean,
    messages: readonly { role: string; content: string }[],
) {
    const message = getEffectivePresetValue(preset, 'echoMessage')
    const delay = getEffectivePresetValue(preset, 'echoDelay')
    const tokensPerSecond = getEffectivePresetValue(preset, 'echoTokensPerSecond')
    return {
        messages: messages.map(({ role, content }) => ({ role, content })),
        message: typeof message === 'string' ? message : echoProfile.defaults.echoMessage,
        delayMs: typeof delay === 'number' && Number.isFinite(delay) ? Math.max(0, delay * 1000) : 0,
        tokensPerSecond: typeof tokensPerSecond === 'number' && Number.isFinite(tokensPerSecond)
            ? Math.max(1, tokensPerSecond)
            : echoProfile.defaults.echoTokensPerSecond,
        model: preset.name,
        stream,
    }
}
