<script lang="ts">
    import type { Component, Snippet } from 'svelte';
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte';
    import ShBadge from 'src/lib/UI/GUI/ShBadge.svelte';
    import { Collapsible } from 'bits-ui';
    import { ChevronDownIcon, FilterIcon } from '@lucide/svelte';
    import { language } from 'src/lang';

    let {
        variant,
        title,
        description,
        first = false,
        stacked = false,
        framed = false,
        embedded = false,
        interactive = false,
        scrollable = false,
        shownCount = 0,
        totalCount = 0,
        loading = false,
        loadingLabel,
        error,
        onclick,
        onkeydown,
        open = $bindable(false),
        activeCount = 0,
        clearLabel,
        onClear,
        className = '',
        actionLabel,
        onAction,
        actionDisabled = false,
        actionVariant = 'outline',
        actionSize = 'sm',
        actionIcon,
        actions = [],
        control,
        children,
    }: {
        variant: 'section' | 'row' | 'panel' | 'action' | 'search' | 'filter' | 'status' | 'list' | 'item';
        title?: string;
        description?: string;
        first?: boolean;
        stacked?: boolean;
        framed?: boolean;
        embedded?: boolean;
        interactive?: boolean;
        scrollable?: boolean;
        shownCount?: number;
        totalCount?: number;
        loading?: boolean;
        loadingLabel?: string;
        error?: string | null;
        onclick?: (event: MouseEvent) => void;
        onkeydown?: (event: KeyboardEvent) => void;
        open?: boolean;
        activeCount?: number;
        clearLabel?: string;
        onClear?: () => void;
        className?: string;
        /** Convenience API for the common settings action buttons. */
        actionLabel?: string;
        onAction?: () => void | Promise<void>;
        actionDisabled?: boolean;
        actionVariant?: 'outline' | 'primary' | 'destructive';
        actionSize?: 'default' | 'sm';
        actionIcon?: Component<{ size?: number }>;
        actions?: Array<{
            label: string;
            onclick: () => void | Promise<void>;
            variant?: 'outline' | 'primary' | 'destructive';
            size?: 'default' | 'sm';
            disabled?: boolean;
            icon?: Component<{ size?: number }>;
        }>;
        control?: Snippet;
        children?: Snippet;
    } = $props();
</script>

{#if variant === 'panel'}
    <div class="border border-darkborderc bg-darkbg/40 rounded-md p-4 mb-4 {className}">
        {@render children?.()}
    </div>
{:else if variant === 'item'}
    {#if interactive}
        <div
            class="flex w-full items-center gap-3 px-3 py-2 cursor-pointer risu-interactive-surface {className}"
            role="button"
            tabindex="0"
            {onclick}
            {onkeydown}
        >
            {@render children?.()}
            {#if control}<div class="flex items-center gap-2 shrink-0">{@render control()}</div>{/if}
        </div>
    {:else}
        <div class="flex w-full items-center gap-3 px-3 py-2 {className}">
            {@render children?.()}
            {#if control}<div class="flex items-center gap-2 shrink-0">{@render control()}</div>{/if}
        </div>
    {/if}
{:else if variant === 'list'}
    <div
        class="flex flex-col bg-darkbg/30 overflow-hidden divide-y divide-darkborderc/50 {className}"
        class:border={!embedded}
        class:border-darkborderc={!embedded}
        class:rounded-md={!embedded}
        class:overflow-y-auto={scrollable}
    >
        {@render children?.()}
    </div>
{:else if variant === 'status'}
    <div class="text-textcolor2 text-xs flex items-center gap-2 {framed ? 'px-3 py-2 border-b border-darkborderc/50 bg-darkbg/30' : 'mb-2'} {className}">
        {#if loading}
            <span>{loadingLabel ?? language.systemLogsLoading}</span>
        {:else if error}
            <span class="text-draculared">{error}</span>
        {:else}
            <span>{language.systemLogsFiltered(shownCount, totalCount)}</span>
        {/if}
    </div>
{:else if variant === 'filter'}
    <Collapsible.Root bind:open>
        <div class="flex items-center justify-between gap-2">
            <Collapsible.Trigger class="group flex items-center gap-1 text-textcolor2 risu-interactive-foreground text-sm transition-colors">
                <FilterIcon size={12} />
                <span>{title}</span>
                {#if activeCount > 0}<ShBadge variant="secondary" className="ml-1">{activeCount}</ShBadge>{/if}
                <ChevronDownIcon size={16} class="transition-transform group-data-[state=closed]:-rotate-90" />
            </Collapsible.Trigger>
            {#if (activeCount > 0 && clearLabel && onClear) || control}
                <div class="flex items-center gap-2 shrink-0">
                    {#if activeCount > 0 && clearLabel && onClear}
                        <button class="text-textcolor2 risu-interactive-foreground text-xs cursor-pointer" onclick={onClear}>{clearLabel}</button>
                    {/if}
                    {#if control}{@render control()}{/if}
                </div>
            {/if}
        </div>
        <Collapsible.Content>
            <div class="pt-2 {className}">{@render children?.()}</div>
        </Collapsible.Content>
    </Collapsible.Root>
{:else if variant === 'search'}
    <div class="flex gap-2 items-stretch {framed ? 'p-2 border-b border-darkborderc/50 bg-darkbg/30' : ''} {className}">
        <div class="flex-1 min-w-0 [&>*]:w-full">{@render children?.()}</div>
        {#if control}<div class="flex items-center gap-2 shrink-0">{@render control()}</div>{/if}
    </div>
{:else if variant === 'action'}
    <div class="flex items-center justify-between gap-3 p-3 border border-darkborderc/50 rounded-md bg-bgcolor/50 {className}">
        <div class="flex flex-col min-w-0 flex-1">
            <span class="text-textcolor text-sm font-medium">{title}</span>
            {#if description}
                <span class="text-textcolor2 text-xs leading-relaxed mt-0.5">{description}</span>
            {/if}
        </div>
        <div class="shrink-0">
            {#if control}
                {@render control()}
            {:else if actions.length > 0}
                <div class="flex items-center gap-2 flex-wrap justify-end">
                    {#each actions as action}
                        <ShButton variant={action.variant ?? 'outline'} size={action.size ?? 'sm'} onclick={action.onclick} disabled={action.disabled}>
                            {#if action.icon}
                                {@const ActionIcon = action.icon}
                                <ActionIcon />
                            {/if}
                            {action.label}
                        </ShButton>
                    {/each}
                </div>
            {:else if actionLabel && onAction}
                <ShButton variant={actionVariant} size={actionSize} onclick={onAction} disabled={actionDisabled}>
                    {#if actionIcon}
                        {@const ActionIcon = actionIcon}
                        <ActionIcon />
                    {/if}
                    {actionLabel}
                </ShButton>
            {/if}
        </div>
    </div>
{:else if variant === 'section'}
    <section class={first ? 'mt-2' : 'mt-8'}>
        <h3 class="text-base font-bold mb-1">{title}</h3>
        {@render children?.()}
    </section>
{:else}
    <div class="py-3 border-t border-darkborderc {className}" class:flex={!stacked} class:items-center={!stacked} class:justify-between={!stacked} class:gap-3={!stacked}>
        <div class="flex flex-col min-w-0">
            <span class="text-sm text-textcolor">{title}</span>
            {#if description}
                <p class="text-xs text-textcolor2 mt-0.5">{description}</p>
            {/if}
        </div>
        {#if stacked}
            <div class="mt-2">{@render children?.()}</div>
        {:else}
            <div class="shrink-0">
                {#if control}
                    {@render control()}
                {:else if actions.length > 0}
                    <div class="flex items-center gap-2 flex-wrap justify-end">
                        {#each actions as action}
                            <ShButton variant={action.variant ?? 'outline'} size={action.size ?? 'sm'} onclick={action.onclick} disabled={action.disabled}>
                                {#if action.icon}
                                    {@const ActionIcon = action.icon}
                                    <ActionIcon />
                                {/if}
                                {action.label}
                            </ShButton>
                        {/each}
                    </div>
                {:else if actionLabel && onAction}
                    <ShButton variant={actionVariant} size={actionSize} onclick={onAction} disabled={actionDisabled}>
                        {#if actionIcon}
                            {@const ActionIcon = actionIcon}
                            <ActionIcon />
                        {/if}
                        {actionLabel}
                    </ShButton>
                {/if}
            </div>
        {/if}
    </div>
{/if}
