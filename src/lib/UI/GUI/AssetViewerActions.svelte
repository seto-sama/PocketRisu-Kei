<script lang="ts">
    import { CopyIcon, DownloadIcon, Trash2Icon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { createSingleFlightRunner } from 'src/ts/util/singleFlight'
    import IconButton from './IconButton.svelte'

    interface Props {
        onCopy?: () => void | Promise<void>
        onDownload?: () => void | Promise<void>
        onDelete?: () => void | Promise<void>
        copyLabel?: string
        downloadLabel?: string
        deleteLabel?: string
    }

    let {
        onCopy,
        onDownload,
        onDelete,
        copyLabel = language.copy,
        downloadLabel = language.download,
        deleteLabel = language.inlayGallery.inlayDelete,
    }: Props = $props()
    const runAction = createSingleFlightRunner('AssetViewerAction')
</script>

{#if onCopy}
    <IconButton onclick={() => runAction('copy', onCopy)} title={copyLabel} aria-label={copyLabel} className="text-maintext">
        <CopyIcon />
    </IconButton>
{/if}
{#if onDownload}
    <IconButton onclick={() => runAction('download', onDownload)} title={downloadLabel} aria-label={downloadLabel} className="text-maintext">
        <DownloadIcon />
    </IconButton>
{/if}
{#if onDelete}
    <IconButton tone="destructive" onclick={() => runAction('delete', onDelete)} title={deleteLabel} aria-label={deleteLabel} className="text-maintext">
        <Trash2Icon />
    </IconButton>
{/if}
