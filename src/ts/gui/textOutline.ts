export const DEFAULT_TEXT_BORDER_COLOR = '#000000';
export const DEFAULT_TEXT_SCREEN_COLOR = '#121212';

export function getTextOutlineStyle(color = DEFAULT_TEXT_BORDER_COLOR): string {
    return [
        `--risu-chat-text-stroke: max(2px, 0.1em) ${color};`,
    ].join('');
}
