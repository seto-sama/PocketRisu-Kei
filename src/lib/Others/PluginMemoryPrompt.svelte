<script lang="ts">
    import { language } from "src/lang";
    import {
        buildPluginMemoryDecision,
        pluginMemoryPromptStore,
        selectedPluginStorageBytes,
        type PluginMemoryPromptData,
    } from "src/ts/plugins/pluginMemorySafety";
    import Dialog from "../UI/components/Dialog.svelte";
    import Button from "../UI/components/Button.svelte";
    import Switch from "../UI/components/Switch.svelte";
    import Alert from "../UI/components/Alert.svelte";
    import { TriangleAlertIcon } from "@lucide/svelte";

    const data = $derived($pluginMemoryPromptStore);
    let initializedPrompt = $state<PluginMemoryPromptData['resolve'] | null>(null);
    let pluginSelections = $state<Array<{
        name: string;
        displayName: string;
        bytes: number;
        enabled: boolean;
    }>>([]);
    let unclassifiedEnabled = $state(true);

    $effect.pre(() => {
        if (!data || initializedPrompt === data.resolve) return;
        initializedPrompt = data.resolve;
        pluginSelections = data.stats.plugins.map(plugin => ({
            ...plugin,
            enabled: true,
        }));
        unclassifiedEnabled = true;
    });

    const enabledPluginNames = $derived(
        pluginSelections.filter(plugin => plugin.enabled).map(plugin => plugin.name),
    );
    const includedBytes = $derived(data
        ? selectedPluginStorageBytes(data.stats, enabledPluginNames, unclassifiedEnabled)
        : 0);
    const bytesToDisable = $derived(Math.max(0, includedBytes - (data?.thresholdBytes ?? 0)));
    const sizeFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

    function formatBytes(bytes:number) {
        if (bytes < 1000) return `${bytes} B`;
        const units = ['KB', 'MB', 'GB', 'TB'];
        let value = bytes / 1000;
        let index = 0;
        while (value >= 1000 && index < units.length - 1) {
            value /= 1000;
            index++;
        }
        return `${sizeFormatter.format(value)} ${units[index]}`;
    }

    function enableAll() {
        for (const plugin of pluginSelections) plugin.enabled = true;
        unclassifiedEnabled = true;
    }

    function disableAll() {
        for (const plugin of pluginSelections) plugin.enabled = false;
        unclassifiedEnabled = false;
    }

    function proceed() {
        const current = $pluginMemoryPromptStore;
        if (!current) return;
        const decision = buildPluginMemoryDecision(
            current.stats,
            enabledPluginNames,
            unclassifiedEnabled,
        );
        pluginMemoryPromptStore.set(null);
        current.resolve(decision);
    }
</script>

{#if data}
    <Dialog
        open={true}
        dismissible={false}
        closable={false}
        size="lg"
        contentClass="max-h-[min(48rem,calc(100dvh-2rem))] overflow-hidden"
        bodyClass="flex min-h-0 flex-1 flex-col overflow-hidden"
        footer={footerActions}
    >
        {#snippet title()}{language.pluginMemoryWarningTitle}{/snippet}

        <div class="flex min-h-0 flex-1 flex-col gap-3">
            <Alert variant="warning" className="px-3 py-2 text-xs sm:px-4 sm:py-3 sm:text-sm">
                {#snippet icon()}<TriangleAlertIcon />{/snippet}
                <span class="sm:hidden">{language.pluginMemoryWarningDescriptionMobile}</span>
                <span class="hidden sm:inline">{language.pluginMemoryWarningDescription}</span>
            </Alert>

            <div class="grid grid-cols-3 gap-2 text-xs sm:text-sm">
                <div class="min-w-0 rounded-md border border-darkborderc bg-lightbg p-2">
                    <div class="text-[11px] leading-tight text-subtext sm:text-sm">{language.pluginMemoryStoredData}</div>
                    <div class="whitespace-nowrap font-medium tabular-nums">{formatBytes(data.stats.totalBytes)}</div>
                </div>
                <div class="min-w-0 rounded-md border border-darkborderc bg-lightbg p-2">
                    <div class="text-[11px] leading-tight text-subtext sm:text-sm">{language.pluginStorageWarningThreshold}</div>
                    <div class="whitespace-nowrap font-medium tabular-nums">{formatBytes(data.thresholdBytes)}</div>
                </div>
                <div class="min-w-0 rounded-md border border-darkborderc bg-lightbg p-2">
                    <div class="text-[11px] leading-tight text-subtext sm:text-sm">{language.pluginMemoryStillToDisable}</div>
                    <div class:text-danger={bytesToDisable > 0} class:text-success={bytesToDisable === 0} class="whitespace-nowrap font-medium tabular-nums">
                        {formatBytes(bytesToDisable)}
                    </div>
                </div>
            </div>

            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="text-sm text-subtext">
                    {language.pluginMemorySelectedTotal.replace('{}', formatBytes(includedBytes))}
                </div>
                <div class="flex gap-2">
                    <Button size="sm" variant="outline" onclick={enableAll}>{language.pluginMemoryEnableAll}</Button>
                    <Button size="sm" variant="outline" onclick={disableAll}>{language.pluginMemoryDisableAll}</Button>
                </div>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto rounded-md border border-darkborderc">
                {#each pluginSelections as plugin (plugin.name)}
                    <div class="flex items-center gap-3 border-b border-darkborderc px-3 py-2 last:border-b-0">
                        <div class="min-w-0 grow">
                            <div class="truncate text-maintext">{plugin.displayName}</div>
                            {#if plugin.displayName !== plugin.name}
                                <div class="truncate text-xs text-subtext">{plugin.name}</div>
                            {/if}
                        </div>
                        <span class="shrink-0 text-sm tabular-nums text-subtext">{formatBytes(plugin.bytes)}</span>
                        <Switch
                            bind:checked={plugin.enabled}
                            ariaLabel={plugin.displayName}
                        />
                    </div>
                {/each}
                {#if data.stats.unclassifiedBytes > 0}
                    <div class="flex items-center gap-3 px-3 py-2">
                        <div class="min-w-0 grow">
                            <div class="text-maintext">{language.pluginMemoryUnclassified}</div>
                            <div class="text-xs text-subtext">{language.pluginMemoryUnclassifiedDescription}</div>
                        </div>
                        <span class="shrink-0 text-sm tabular-nums text-subtext">{formatBytes(data.stats.unclassifiedBytes)}</span>
                        <Switch
                            bind:checked={unclassifiedEnabled}
                            ariaLabel={language.pluginMemoryUnclassified}
                        />
                    </div>
                {/if}
            </div>
        </div>
    </Dialog>
{/if}

{#snippet footerActions()}
    <div class="flex w-full justify-end">
        <Button variant="primary" onclick={proceed}>{language.pluginMemoryProceed}</Button>
    </div>
{/snippet}
