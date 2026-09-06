export interface FolderColorStyle {
    fill: string;
    border: string;
    accent: string;
}

const defaultFolderColorStyle: FolderColorStyle = {
    fill: 'bg-darkbg/20',
    border: 'border-selected',
    accent: 'var(--risu-theme-subtext)',
};

export const folderColorStyles: Readonly<Record<string, FolderColorStyle>> = {
    red: { fill: 'bg-danger/20', border: 'border-danger/40', accent: 'var(--risu-theme-danger)' },
    orange: { fill: 'bg-highlight/20', border: 'border-highlight/40', accent: 'var(--risu-theme-highlight)' },
    yellow: { fill: 'bg-warning/20', border: 'border-warning/40', accent: 'var(--risu-theme-warning)' },
    green: { fill: 'bg-success/20', border: 'border-success/40', accent: 'var(--risu-theme-success)' },
    blue: { fill: 'bg-primary/20', border: 'border-primary/40', accent: 'var(--risu-theme-primary)' },
    indigo: { fill: 'bg-accent/20', border: 'border-accent/40', accent: 'var(--risu-theme-accent)' },
    purple: { fill: 'bg-scoped/20', border: 'border-scoped/40', accent: 'var(--risu-theme-scoped)' },
    // Keep folders saved with the former palette's pink option theme-aware.
    pink: { fill: 'bg-scoped/20', border: 'border-scoped/40', accent: 'var(--risu-theme-scoped)' },
};

export const folderColorOptions = [
    { label: 'Color 1', value: 'red' },
    { label: 'Color 2', value: 'orange' },
    { label: 'Color 3', value: 'yellow' },
    { label: 'Color 4', value: 'green' },
    { label: 'Color 5', value: 'blue' },
    { label: 'Color 6', value: 'indigo' },
    { label: 'Color 7', value: 'purple' },
    { label: 'Default', value: 'default' },
] as const;

export function getFolderColorStyle(color?: string | null): FolderColorStyle {
    if (color && /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) {
        return {
            fill: 'bg-[color-mix(in_srgb,var(--risu-folder-color)_20%,transparent)]',
            border: 'border-[color-mix(in_srgb,var(--risu-folder-color)_40%,transparent)]',
            accent: color,
        };
    }
    return color ? folderColorStyles[color] ?? defaultFolderColorStyle : defaultFolderColorStyle;
}
