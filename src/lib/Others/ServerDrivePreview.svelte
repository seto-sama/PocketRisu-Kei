<script lang="ts">
    import { language } from 'src/lang'
    import { showPopupEditor } from 'src/ts/stores.svelte'
    import type { DriveEntry } from 'src/ts/storage/nodeStorage'
    import { getFileType } from '../../../shared/fileTypes.mjs'
    import Button from '../UI/components/Button.svelte'
    import Dialog from '../UI/components/Dialog.svelte'
    import EmptyState from '../UI/components/EmptyState.svelte'

    let { entry, file, thumbnailUrl = '', busy = false, onImport, onDownload, onClose }: {
        entry: DriveEntry
        /** Downloaded contents; null previews the entry through its server thumbnail only. */
        file: File | null
        thumbnailUrl?: string
        busy?: boolean
        onImport?: () => void
        onDownload: () => void
        onClose: () => void
    } = $props()
    const maxTextBytes = 1024 * 1024
    const kind = $derived(!file ? (thumbnailUrl ? 'image' : 'unsupported')
        : getFileType(file.name) === 'image' || /\.(svg|ico)$/i.test(file.name) ? 'image'
        : /\.(mp4|webm|mov|m4v)$/i.test(file.name) ? 'video'
        : /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(file.name) ? 'audio'
        : /\.pdf$/i.test(file.name) ? 'unsupported' : 'text')
    let url = $state('')
    let loading = $state(true)
    let failed = $state(false)

    $effect(() => {
        const source = file
        loading = true
        failed = false
        if (kind === 'unsupported') {
            failed = true
            loading = false
            return
        }
        if (!source) {
            url = thumbnailUrl
            loading = false
            return
        }
        if (kind !== 'text') {
            const objectUrl = URL.createObjectURL(source)
            url = objectUrl
            loading = false
            return () => URL.revokeObjectURL(objectUrl)
        }
        let cancelled = false
        void source.slice(0, maxTextBytes).arrayBuffer().then(buffer => {
            if (cancelled) return
            // stream avoids a broken final UTF-8 character when the preview is truncated.
            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer, { stream: source.size > maxTextBytes })
            if (/[\x00-\x08\x0e-\x1f]/.test(decoded)) throw new Error('Binary file')
            showPopupEditor({
                value: decoded,
                title: source.name,
                description: source.size > maxTextBytes ? language.serverDrive.previewTruncated : '',
                mode: 'plain',
                submitKind: 'download',
                onSubmit: () => { onDownload(); return false },
            })
            onClose()
        }).catch(() => { if (!cancelled) failed = true })
            .finally(() => { if (!cancelled) loading = false })
        return () => { cancelled = true }
    })
</script>

<!-- Every preview shares one dialog size and stage height so switching file types keeps the same frame. -->
<Dialog open={kind !== 'text' || failed} onOpenChange={(open) => { if (!open) onClose() }} size="lg">
    {#snippet title()}<span class="break-all">{entry.name}</span>{/snippet}
    <div class="flex h-[min(60dvh,32rem)] items-center justify-center overflow-hidden">
        {#if loading}
            <p class="text-sm text-subtext" role="status">{language.loading}…</p>
        {:else if failed}
            <EmptyState title={language.serverDrive.previewUnavailable} description="" layout="section" />
        {:else if kind === 'image'}
            <img src={url} alt={entry.name} class="max-h-full max-w-full object-contain" onerror={() => { failed = true }} />
        {:else if kind === 'video'}
            <!-- svelte-ignore a11y_media_has_caption: user-provided media has no caption source -->
            <video src={url} controls playsinline class="max-h-full max-w-full" onerror={() => { failed = true }}></video>
        {:else if kind === 'audio'}
            <audio src={url} controls class="w-full" onerror={() => { failed = true }}></audio>
        {/if}
    </div>
    {#snippet footer()}
        <Button size="sm" variant="outline" onclick={onClose}>{language.close}</Button>
        {#if onImport}
            <Button size="sm" disabled={busy} onclick={onImport}>{language.serverDrive.import}</Button>
        {:else if failed}
            <Button size="sm" onclick={onDownload}>{language.download}</Button>
        {/if}
    {/snippet}
</Dialog>
