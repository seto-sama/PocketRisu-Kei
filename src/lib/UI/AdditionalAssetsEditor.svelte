<script lang="ts">
    import { Copy, DownloadIcon, FileIcon, FileMusicIcon, FileVideoIcon, ImageIcon, ImageOffIcon, PlusIcon, TrashIcon } from '@lucide/svelte';
    import { language } from 'src/lang';
    import { alertConfirm, notifyError, notifySuccess } from 'src/ts/alert';
    import { downloadFile, getFileSrc, saveAsset } from 'src/ts/globalApi.svelte';
    import { DBState, SizeStore } from 'src/ts/stores.svelte';
    import { selectMultipleFile } from 'src/ts/util';
    import { onDestroy } from 'svelte';
    import FullscreenImageViewer from './GUI/FullscreenImageViewer.svelte';
    import IconButton from './GUI/IconButton.svelte';
    import IconButtonGroup from './GUI/IconButtonGroup.svelte';
    import ShInput from './GUI/ShInput.svelte';
    import { createIncrementalList } from './incrementalList.svelte';

    type AdditionalAsset = [string, string, string];

    interface Props {
        assets: AdditionalAsset[];
        onChange: (assets: AdditionalAsset[]) => void;
        onDelete?: (asset: AdditionalAsset, index: number) => void;
        showExclusionToggle?: boolean;
        excludedPaths?: string[];
        onExcludedPathsChange?: (paths: string[]) => void;
        acceptedExtensions?: string[];
        previewAllAsImages?: boolean;
    }

    let {
        assets,
        onChange,
        onDelete,
        showExclusionToggle = false,
        excludedPaths = [],
        onExcludedPathsChange,
        acceptedExtensions = ['png', 'webp', 'mp4', 'mp3', 'gif', 'jpeg', 'jpg', 'ttf', 'otf', 'css', 'webm', 'woff', 'woff2', 'svg', 'avif'],
        previewAllAsImages = false,
    }: Props = $props();

    const previewableImageExtensions = ['png', 'webp', 'jpeg', 'jpg', 'gif', 'svg', 'avif'];
    const loadingAssetPaths = new Set<string>();
    const observedAssetPaths = new WeakMap<Element, string>();
    let assetObserver: IntersectionObserver | null = null;
    let destroyed = false;
    let assetFilePaths = $state<Record<string, string>>({});
    let assetImageDimensions = $state<Record<string, { width: number, height: number }>>({});
    let previewIndex = $state(-1);
    let previewInfoOpen = $state(false);
    const incrementalList = createIncrementalList({ pageSize: 40, rootMargin: '400px 0px' });
    const observePagingSentinel = incrementalList.observeSentinel;

    const extensionOf = (asset: AdditionalAsset) => (asset[2] || asset[1].split('.').pop() || '').toLowerCase();
    let previewIndexes = $derived.by(() => assets
        .map((asset, index) => ({ asset, index }))
        .filter(({ asset }) => (previewAllAsImages || previewableImageExtensions.includes(extensionOf(asset))) && !!assetFilePaths[asset[1]])
        .map(({ index }) => index));
    let previewPosition = $derived(previewIndexes.indexOf(previewIndex));
    let previewAsset = $derived(previewIndex >= 0 ? assets[previewIndex] ?? null : null);
    let previewPath = $derived(previewAsset ? assetFilePaths[previewAsset[1]] ?? '' : '');
    let previewDimensions = $derived(previewAsset ? assetImageDimensions[previewAsset[1]] : undefined);
    let displayedAssets = $derived(incrementalList.slice(assets));
    let hasMoreAssets = $derived(incrementalList.hasMore(assets.length));
    let currentAssetPaths = $derived(new Set(assets.map((asset) => asset[1])));

    function loadAssetPreview(path: string) {
        if(assetFilePaths[path] || loadingAssetPaths.has(path)){
            return;
        }
        loadingAssetPaths.add(path);
        void getFileSrc(path)
            .then((filePath) => {
                if(!destroyed && filePath && currentAssetPaths.has(path)){
                    assetFilePaths[path] = filePath;
                }
            })
            .finally(() => {
                loadingAssetPaths.delete(path);
            });
    }

    function getAssetObserver() {
        if(assetObserver || typeof IntersectionObserver === 'undefined'){
            return assetObserver;
        }
        assetObserver = new IntersectionObserver((entries) => {
            for(const entry of entries){
                if(!entry.isIntersecting){
                    continue;
                }
                const path = observedAssetPaths.get(entry.target);
                assetObserver?.unobserve(entry.target);
                if(path){
                    loadAssetPreview(path);
                }
            }
        }, { rootMargin: '200px 0px' });
        return assetObserver;
    }

    function lazyLoadAssetPreview(
        node: HTMLElement,
        options: { path: string, enabled: boolean },
    ) {
        function observe({ path, enabled }: typeof options) {
            assetObserver?.unobserve(node);
            observedAssetPaths.set(node, path);
            if(!enabled || assetFilePaths[path]){
                return;
            }
            const observer = getAssetObserver();
            if(observer){
                observer.observe(node);
            }
            else {
                loadAssetPreview(path);
            }
        }

        observe(options);
        return {
            update: observe,
            destroy: () => assetObserver?.unobserve(node),
        };
    }

    onDestroy(() => {
        destroyed = true;
        assetObserver?.disconnect();
    });

    $effect(() => {
        if(previewIndex >= assets.length){
            previewIndex = -1;
        }
    });

    async function addAssets() {
        const files = await selectMultipleFile(acceptedExtensions);
        if(!files){
            return;
        }
        const added: AdditionalAsset[] = [];
        for(const file of files){
            const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
            const path = await saveAsset(file.data, '', extension);
            added.push([file.name, path, extension]);
        }
        onChange([...assets, ...added]);
    }

    function renameAsset(index: number, name: string) {
        onChange(assets.map((asset, assetIndex) => assetIndex === index ? [name, asset[1], asset[2]] : asset));
    }

    function openPreview(index: number) {
        previewIndex = index;
        previewInfoOpen = $SizeStore.w >= 768;
    }

    function recordImageDimensions(event: Event, assetPath: string) {
        const image = event.currentTarget as HTMLImageElement;
        if(image.naturalWidth > 0 && image.naturalHeight > 0){
            assetImageDimensions[assetPath] = {
                width: image.naturalWidth,
                height: image.naturalHeight,
            };
        }
    }

    async function copyRawReference(name: string) {
        try {
            await navigator.clipboard.writeText(`{{raw::${name}}}`);
            notifySuccess(language.copied);
        }
        catch(error){
            notifyError(`${error}`);
        }
    }

    async function downloadPreview() {
        if(!previewAsset || !previewPath){
            return;
        }
        try {
            const response = await fetch(previewPath);
            if(!response.ok){
                throw new Error(`Failed to load asset: ${response.status}`);
            }
            const name = previewAsset[0];
            const extension = previewAsset[2];
            const downloadName = extension && !name.toLowerCase().endsWith(`.${extension.toLowerCase()}`)
                ? `${name}.${extension}`
                : name;
            await downloadFile(downloadName, await response.arrayBuffer());
            notifySuccess(language.successExport);
        }
        catch(error){
            notifyError(`${error}`);
        }
    }

    async function deleteAsset(index: number, confirm = false) {
        const asset = assets[index];
        if(!asset){
            return;
        }
        if(confirm && !(await alertConfirm(`${language.removeConfirm}${asset[0]}`))){
            return;
        }

        const currentPreviewPosition = previewIndexes.indexOf(index);
        const neighborIndex = currentPreviewPosition >= 0
            ? previewIndexes[currentPreviewPosition + 1] ?? previewIndexes[currentPreviewPosition - 1]
            : undefined;

        onChange(assets.filter((_, assetIndex) => assetIndex !== index));
        onDelete?.(asset, index);
        if(excludedPaths.includes(asset[1])){
            onExcludedPathsChange?.(excludedPaths.filter((path) => path !== asset[1]));
        }
        delete assetImageDimensions[asset[1]];

        if(previewIndex === index){
            previewIndex = neighborIndex === undefined ? -1 : neighborIndex > index ? neighborIndex - 1 : neighborIndex;
        }
        else if(previewIndex > index){
            previewIndex -= 1;
        }
    }

    function toggleExcluded(assetPath: string) {
        if(excludedPaths.includes(assetPath)){
            onExcludedPathsChange?.(excludedPaths.filter((path) => path !== assetPath));
        }
        else {
            onExcludedPathsChange?.([...excludedPaths, assetPath]);
        }
    }

    function goToPreviewNeighbor(offset: -1 | 1) {
        if(previewPosition < 0){
            return;
        }
        const nextIndex = previewIndexes[previewPosition + offset];
        if(nextIndex !== undefined){
            previewIndex = nextIndex;
        }
    }
</script>

<div class="w-full max-w-full max-h-full overflow-x-hidden overflow-y-auto border border-selected rounded-md mt-2">
    {#if assets.length === 0}
        <div class="min-h-20 flex items-center justify-center px-3 py-4 text-sm text-textcolor2">
            {language.noData}
        </div>
    {:else}
        {#each displayedAssets as asset, i}
            {@const extension = extensionOf(asset)}
            <div class="flex min-w-0 items-center gap-2 p-2 {i > 0 ? 'border-t border-darkborderc/20' : ''}">
                <div
                    class="w-14 h-14 shrink-0 overflow-hidden rounded-md border border-darkborderc bg-darkbg flex items-center justify-center text-textcolor2"
                    use:lazyLoadAssetPreview={{ path: asset[1], enabled: DBState.db.useAdditionalAssetsPreview }}
                >
                    {#if assetFilePaths[asset[1]] && DBState.db.useAdditionalAssetsPreview}
                        {#if previewAllAsImages || previewableImageExtensions.includes(extension)}
                            <button
                                class="w-full h-full cursor-zoom-in"
                                onclick={() => openPreview(i)}
                                title={asset[0]}
                                aria-label={asset[0]}
                            >
                                <img
                                    src={assetFilePaths[asset[1]]}
                                    class="w-full h-full object-cover object-top"
                                    alt={asset[0]}
                                    loading="lazy"
                                    decoding="async"
                                    onload={(event) => recordImageDimensions(event, asset[1])}
                                />
                            </button>
                        {:else if ['mp4', 'webm'].includes(extension)}
                            <!-- svelte-ignore a11y_media_has_caption -->
                            <video class="w-full h-full object-cover" preload="none"><source src={assetFilePaths[asset[1]]} /></video>
                        {:else if extension === 'mp3'}
                            <FileMusicIcon size={22} />
                        {:else}
                            <FileIcon size={22} />
                        {/if}
                    {:else if ['mp4', 'webm'].includes(extension)}
                        <FileVideoIcon size={22} />
                    {:else if extension === 'mp3'}
                        <FileMusicIcon size={22} />
                    {:else}
                        <FileIcon size={22} />
                    {/if}
                </div>

                <div class="min-w-0 flex-1">
                    <ShInput
                        autocomplete="off"
                        value={asset[0]}
                        oninput={(event) => renameAsset(i, event.currentTarget.value)}
                        placeholder="..."
                    />
                    <span class="mt-1 block truncate text-[10px] uppercase text-textcolor2">{extension}</span>
                </div>

                <IconButtonGroup direction="vertical" size="sm">
                    {#if showExclusionToggle}
                        <IconButton onclick={() => toggleExcluded(asset[1])}>
                            {#if excludedPaths.includes(asset[1])}
                                <ImageOffIcon />
                            {:else}
                                <ImageIcon />
                            {/if}
                        </IconButton>
                    {/if}
                    <IconButton tone="destructive" onclick={() => deleteAsset(i)}>
                        <TrashIcon />
                    </IconButton>
                </IconButtonGroup>
            </div>
        {/each}
        {#if hasMoreAssets}
            <div use:observePagingSentinel={assets.length} class="h-px w-full" aria-hidden="true"></div>
        {/if}
    {/if}
</div>
<div class="mt-2 flex justify-start">
    <IconButton onclick={addAssets}>
        <PlusIcon />
    </IconButton>
</div>

<FullscreenImageViewer
    open={previewIndex >= 0 && !!previewAsset && !!previewPath}
    src={previewPath}
    alt={previewAsset?.[0] ?? ''}
    title={previewAsset?.[0] ?? ''}
    position={previewPosition}
    total={previewIndexes.length}
    canGoPrev={previewPosition > 0}
    canGoNext={previewPosition >= 0 && previewPosition < previewIndexes.length - 1}
    bind:infoOpen={previewInfoOpen}
    infoLabel={language.playground.inlayInfo}
    downloadLabel={language.download}
    closeLabel={language.goback}
    onClose={() => (previewIndex = -1)}
    onPrev={() => goToPreviewNeighbor(-1)}
    onNext={() => goToPreviewNeighbor(1)}
    onDownload={downloadPreview}
>
    {#snippet info()}
        {#if previewAsset}
            <div class="px-4 py-3 space-y-1.5">
                <p class="text-textcolor text-sm font-medium break-all leading-snug" title={previewAsset[0]}>
                    {previewAsset[0]}
                </p>
                {#if previewAsset[2]}
                    <p class="text-textcolor2 text-xs uppercase font-mono">{previewAsset[2]}</p>
                {/if}
                {#if previewDimensions}
                    <p class="text-textcolor2 text-xs">{previewDimensions.width} × {previewDimensions.height} px</p>
                {/if}
            </div>

            <div class="px-4 py-4 space-y-2">
                <h3 class="text-textcolor2 text-[11px] font-semibold uppercase tracking-wider">
                    {language.playground.inlayActions}
                </h3>
                <button
                    type="button"
                    onclick={() => copyRawReference(previewAsset[0])}
                    class="w-full flex items-center gap-2 px-3 py-2 rounded border border-darkborderc risu-interactive-surface-strong text-textcolor2 risu-interactive-foreground text-sm transition-colors"
                >
                    <Copy size={14} />
                    {language.copy}
                </button>
                <button
                    type="button"
                    onclick={downloadPreview}
                    class="w-full flex items-center gap-2 px-3 py-2 rounded border border-darkborderc risu-interactive-surface-strong text-textcolor2 risu-interactive-foreground text-sm transition-colors"
                >
                    <DownloadIcon size={12} />
                    {language.download}
                </button>
                <button
                    type="button"
                    onclick={() => deleteAsset(previewIndex, true)}
                    class="w-full flex items-center gap-2 px-3 py-2 rounded border border-draculared/40 hover:bg-draculared/15 text-draculared text-sm transition-colors"
                >
                    <TrashIcon size={12} />
                    {language.remove}
                </button>
            </div>
        {/if}
    {/snippet}
</FullscreenImageViewer>
