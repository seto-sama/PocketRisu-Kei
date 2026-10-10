<script lang="ts">
    import DOMPurify from 'dompurify';

    let {
        ico,
        className = ''
    }: {
        ico: {
            iconType:'html'|'img'|'none',
            icon:string
        },
        className?:string
    } = $props()

    const allowedIconProtocols = ['http:', 'https:', 'data:', 'blob:'];

    const sanitizeIconHtml = (icon:string) => DOMPurify.sanitize(icon, {
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'],
        FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'style', 'class']
    });

    const getSafeIconUrl = (url:string) => {
        try {
            const parsedUrl = new URL(url, document.baseURI);
            if (!allowedIconProtocols.includes(parsedUrl.protocol)) {
                console.warn(`Blocked URL with unsafe protocol: ${parsedUrl.protocol}`);
                return '';
            }
            return url;
        } catch {
            console.warn(`Invalid URL: ${url}`);
            return '';
        }
    }
</script>

<div
    class="plugin-defined-icon shrink-0 {className}"
    style="width: var(--icon-size, 20px); height: var(--icon-size, 20px);"
>
    {#if ico.iconType === 'html'}
        {@html sanitizeIconHtml(ico.icon)}
    {:else if ico.iconType === 'img'}
        <img src={getSafeIconUrl(ico.icon)} alt="icon" />
    {/if}
</div>

<style>
    .plugin-defined-icon :global(svg),
    .plugin-defined-icon img {
        width: 100%;
        height: 100%;
    }
</style>
