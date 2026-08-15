export const DEFAULT_TEXT_BORDER_COLOR = '#000000';
export const DEFAULT_TEXT_SCREEN_COLOR = '#121212';

export function getTextOutlineStyle(color = DEFAULT_TEXT_BORDER_COLOR): string {
    return [
        `-1px -1px 0 ${color}`,
        `1px -1px 0 ${color}`,
        `-1px 1px 0 ${color}`,
        `1px 1px 0 ${color}`,
    ].join(', ');
}
