<script lang="ts">
    import { language } from 'src/lang';
    import { cn } from 'src/lib/utils';

    let {
        title = language.noSearchResults,
        description = language.noSearchResultsDesc,
        layout = 'content',
        density = 'normal',
        size = layout === 'inline' ? 'sm' : 'default',
        className = '',
    }: {
        title?: string;
        description?: string;
        /** content: parent owns spacing; overlay: requires a positioned parent. */
        layout?: 'content' | 'inline' | 'overlay' | 'section';
        density?: 'compact' | 'normal' | 'spacious';
        size?: 'default' | 'sm';
        className?: string;
    } = $props();
</script>

<div data-slot="empty-state" class={cn(
    'flex flex-col items-center justify-center gap-1 text-center',
    layout === 'overlay' && 'pointer-events-none absolute inset-0 p-2',
    (layout === 'inline' || layout === 'section') && 'px-3',
    (layout === 'inline' || layout === 'section') && (
        density === 'compact' ? 'py-4' : density === 'spacious' ? 'py-12' : 'py-8'
    ),
    className,
)}>
    <div class={cn('leading-normal', size === 'sm' ? 'text-sm text-subtext' : 'text-base font-medium text-maintext')}>{title}</div>
    {#if description}
        <div class="text-sm leading-relaxed text-subtext">{description}</div>
    {/if}
</div>
