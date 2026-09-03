import type { SettingItem } from './types';

export const inlayImageSettingsItems: SettingItem[] = [
    {
        id: 'inlay.compression', type: 'check', labelKey: 'inlayImageCompression', bindKey: 'inlayImageCompression',
        helpKey: 'inlayImageCompression', classes: 'mt-4',
    },
    {
        id: 'inlay.size', type: 'select', labelKey: 'inlayImageSize', bindKey: 'inlayImageSize',
        helpKey: 'inlayImageSize', condition: ({ db }) => db.inlayImageCompression, options: {
            selectOptions: [
                { value: '1k', label: '1K' },
                { value: '2k', label: '2K' },
                { value: '4k', label: '4K' },
                { value: 'original', labelKey: 'originalSize' },
            ],
        },
    },
    {
        id: 'inlay.format', type: 'select', labelKey: 'inlayImageFormat', bindKey: 'inlayImageFormat',
        helpKey: 'inlayImageFormat', condition: ({ db }) => db.inlayImageCompression, options: {
            selectOptions: [
                { value: 'webp', label: 'WebP' },
                { value: 'png', label: 'PNG' },
            ],
        },
    },
    {
        id: 'inlay.lossy', type: 'check', labelKey: 'inlayImageLossy', bindKey: 'inlayImageLossy',
        helpKey: 'inlayImageLossy', condition: ({ db }) => db.inlayImageCompression && db.inlayImageFormat === 'webp',
    },
    {
        id: 'inlay.quality', type: 'slider', labelKey: 'inlayImageQuality', bindKey: 'inlayImageQuality',
        helpKey: 'inlayImageQuality',
        condition: ({ db }) => db.inlayImageCompression && db.inlayImageFormat === 'webp' && db.inlayImageLossy,
        options: {
            min: 0.01, max: 1, step: 0.01, fixed: 2,
        },
    },
    {
        id: 'inlay.compress', type: 'custom', componentId: 'InlayCompressButton',
        condition: ({ db }) => db.inlayImageCompression,
    },
];
