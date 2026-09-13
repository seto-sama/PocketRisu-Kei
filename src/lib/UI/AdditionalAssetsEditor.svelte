<script lang="ts">
    import EmptyState from "src/lib/UI/components/EmptyState.svelte";
    import { FileIcon, FileMusicIcon, FileVideoIcon, ImageIcon, ImageOffIcon, PlusIcon, TrashIcon } from '@lucide/svelte';
    import { language } from 'src/lang';
    import { alertConfirm, notifyError, notifySuccess } from 'src/ts/alert';
    import { downloadFile, getFileSrc, saveAsset } from 'src/ts/globalApi.svelte';
    import { DBState } from 'src/ts/stores.svelte';
    import { selectMultipleFile } from 'src/ts/util';
    import { onDestroy } from 'svelte';
    import FullscreenImageViewer from './components/FullscreenImageViewer.svelte';
    import AssetViewerActions from './components/AssetViewerActions.svelte';
    import IconButton from './components/IconButton.svelte';
    import IconButtonGroup from './components/IconButtonGroup.svelte';
    import ListActionBar from './components/ListActionBar.svelte';
    import Input from './components/Input.svelte';
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
    let deletingAsset = false;
    const incrementalList = createIncrementalList({ pageSize: 40, rootMargin: '400px 0px' });
    const observePagingSentinel = incrementalList.observeSentinel;

    const extensionOf = (asset: AdditionalAsset) => (asset[2] || asset[1].split('.').pop() || '').toLowerCase();
    let previewIndexes = $derived.by(() => assets
        .map((asset, index) => ({ asset, index }))
        .filter(({ asset }) => previewAllAsImages || previewableImageExtensions.includes(extensionOf(asset)))
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

    $effect(() => {
        if(previewAsset){
            loadAssetPreview(previewAsset[1]);
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
        if(deletingAsset){
            return;
        }
        const asset = assets[index];
        if(!asset){
            return;
        }
        deletingAsset = true;
        try {
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
        } finally {
            deletingAsset = false;
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
        if(previewPosition < 0 || previewIndexes.length < 2){
            return;
        }
        const nextPosition = (previewPosition + offset + previewIndexes.length) % previewIndexes.length;
        previewIndex = previewIndexes[nextPosition];
    }
</script>

<div class="mt-2 w-full max-w-full overflow-x-hidden">
    {#if assets.length === 0}
        <EmptyState title={language.noAssets} description="" layout="inline" />
    {:else}
        {#each displayedAssets as asset, i}
            {@const extension = extensionOf(asset)}
            <div class="flex min-w-0 items-start gap-2 py-2 {i > 0 ? 'border-t border-darkborderc/20' : ''}">
                <div
                    class="w-14 h-14 shrink-0 overflow-hidden rounded-md border border-darkborderc bg-darkbg flex items-center justify-center text-subtext"
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

                <div class="h-14 min-w-0 flex-1 overflow-hidden">
                    <Input
                        autocomplete="off"
                        value={asset[0]}
                        oninput={(event) => renameAsset(i, event.currentTarget.value)}
                        placeholder="..."
                        className="h-9 min-h-9"
                    />
                    <span class="mt-1 block truncate text-[10px] leading-3 uppercase text-subtext">{extension}</span>
                </div>

                <IconButtonGroup direction="vertical" size="sm" className="self-center">
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
<ListActionBar mode="footer">
    <IconButton onclick={addAssets} title={language.selectFile} aria-label={language.selectFile}>
        <PlusIcon />
    </IconButton>
</ListActionBar>

<FullscreenImageViewer
    open={previewIndex >= 0 && !!previewAsset}
    src={previewPath}
    alt={previewAsset?.[0] ?? ''}
    title={previewAsset?.[0] ?? ''}
    subtitle={previewAsset?.[1] ?? ''}
    position={previewPosition}
    total={previewIndexes.length}
    canGoPrev={previewPosition >= 0 && previewIndexes.length > 1}
    canGoNext={previewPosition >= 0 && previewIndexes.length > 1}
    loading={!previewPath}
    loadingLabel={language.inlayGallery.inlayLoadingOriginal}
    metadataLabel={language.inlayGallery.inlayInfo}
    closeLabel={language.goback}
    onOpenChange={(open) => { if (!open) previewIndex = -1 }}
    onPrev={() => goToPreviewNeighbor(-1)}
    onNext={() => goToPreviewNeighbor(1)}
    onDelete={() => deleteAsset(previewIndex, true)}
    onDownload={downloadPreview}
>
    {#snippet actions()}
        {#if previewAsset}
            <AssetViewerActions
                onCopy={() => copyRawReference(previewAsset[0])}
                onDownload={downloadPreview}
                onDelete={() => deleteAsset(previewIndex, true)}
                deleteLabel={language.remove}
            />
        {/if}
    {/snippet}

    {#snippet metadataOverlay()}
        {#if previewAsset}
            <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt class="text-subtext">{language.imageInfo}</dt>
                <dd class="text-maintext">
                    {#if previewDimensions}{previewDimensions.width} × {previewDimensions.height}{#if extensionOf(previewAsset)} ({extensionOf(previewAsset).toUpperCase()}){/if}{:else}{extensionOf(previewAsset)?.toUpperCase() ?? ''}{/if}
                </dd>
            </dl>
        {/if}
    {/snippet}
</FullscreenImageViewer>
