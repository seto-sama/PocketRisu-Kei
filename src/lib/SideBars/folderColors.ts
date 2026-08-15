export interface FolderColorStyle {
    fill: string;
    border: string;
}

const defaultFolderColorStyle: FolderColorStyle = {
    fill: 'bg-darkbg/20',
    border: 'border-selected',
};

export const folderColorStyles: Readonly<Record<string, FolderColorStyle>> = {
    red: { fill: 'bg-draculared/20', border: 'border-draculared/40' },
    orange: { fill: 'bg-highlight/20', border: 'border-highlight/40' },
    yellow: { fill: 'bg-warning/20', border: 'border-warning/40' },
    green: { fill: 'bg-success/20', border: 'border-success/40' },
    blue: { fill: 'bg-primary/20', border: 'border-primary/40' },
    indigo: { fill: 'bg-accent/20', border: 'border-accent/40' },
    purple: { fill: 'bg-scoped/20', border: 'border-scoped/40' },
    // Keep folders saved with the former palette's pink option theme-aware.
    pink: { fill: 'bg-scoped/20', border: 'border-scoped/40' },
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
    return color ? folderColorStyles[color] ?? defaultFolderColorStyle : defaultFolderColorStyle;
}
