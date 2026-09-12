/// <reference types="svelte" />
/// <reference types="vite/client" />


declare module 'virtual:pocketrisu-local-fonts.css' {}

declare module 'virtual:pocketrisu-local-font-families' {
    export const localFontFamilies: readonly {
        family: string
        variableWeight: boolean
    }[]
}
