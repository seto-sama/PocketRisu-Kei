const fileTypes = {
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    gif: 'image',
    webp: 'image',
    bmp: 'image',
    avif: 'image',
    charx: 'character',
    risup: 'preset',
    risupreset: 'preset',
    risum: 'module',
    json: 'json',
};

export function getFileType(name) {
    const dot = name.lastIndexOf('.');
    const extension = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
    return Object.hasOwn(fileTypes, extension) ? fileTypes[extension] : 'file';
}
