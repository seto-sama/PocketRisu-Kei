/// <reference types="svelte" />
/// <reference types="vite/client" />


declare var Buffer: BufferConstructor
declare var safeStructuredClone: <T>(data: T) => T

declare module 'virtual:pocketrisu-local-fonts.css' {}

declare module 'virtual:pocketrisu-local-font-families' {
    export const localFontFamilies: readonly {
        family: string
        variableWeight: boolean
    }[]
}
