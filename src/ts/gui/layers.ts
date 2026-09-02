export type DialogLayerTier = 'base' | 'alert' | 'top'

export const dialogLayerClasses: Record<DialogLayerTier, string> = {
    base: 'risu-layer-dialog-base',
    alert: 'risu-layer-dialog-alert',
    top: 'risu-layer-dialog-top',
}

export const layerZIndexes = {
    dialogBase: 'var(--risu-z-dialog-base)',
    dialogTop: 'var(--risu-z-dialog-top)',
    systemPopover: 'var(--risu-z-system-popover)',
    localPopover: 'var(--risu-z-local-popover)',
} as const
