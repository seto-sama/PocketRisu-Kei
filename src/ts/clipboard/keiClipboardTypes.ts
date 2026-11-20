export interface KeiClipboardEntry {
    id: string
    text: string
    createdAt: number
    pinned: boolean
}

export interface KeiClipboardCatalog {
    entries: KeiClipboardEntry[]
}
