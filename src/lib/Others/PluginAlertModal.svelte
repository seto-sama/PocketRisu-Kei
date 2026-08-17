<script lang="ts">
    import { TriangleAlertIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import ShAlert from "src/lib/UI/GUI/ShAlert.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShDialog from "src/lib/UI/GUI/ShDialog.svelte";
    import { pluginAlertModalStore } from "src/ts/stores.svelte";

    const reasons: [string, string][] = $derived.by(() => {
        const mapped = pluginAlertModalStore.errors.map(error => [
            language.pluginRisksInuserFriendly[error.userAlertKey],
            language.pluginRisksInuserFriendlyDesc[error.userAlertKey],
        ] as [string, string]);

        return mapped.filter((item, index) =>
            mapped.findIndex(candidate => candidate[0] === item[0]) === index
        );
    });

    function rejectPlugin() {
        pluginAlertModalStore.open = false;
    }

    function continueAnyway() {
        pluginAlertModalStore.errors = [];
        pluginAlertModalStore.open = false;
    }
</script>

{#if pluginAlertModalStore.open}
    <ShDialog
        open={true}
        onOpenChange={(open) => { if (!open) rejectPlugin(); }}
        closable={false}
        closeOnEscape={false}
        closeOnOutsideClick={false}
        tier="alert"
        size="default"
        footer={footerActions}
    >
        {#snippet title()}{language.pluginRiskDetectedTitle}{/snippet}

        <ShAlert variant="destructive">
            {#snippet icon()}<TriangleAlertIcon />{/snippet}
            <p class="m-0">{language.pluginRiskDetectedAlert}</p>
            <ul class="mt-3 flex list-none flex-col divide-y divide-draculared/30 border-t border-draculared/30 p-0 pt-1 text-sm">
                {#each reasons as reason}
                    <li class="py-2.5 first:pt-1.5 last:pb-0">
                        <div class="font-semibold">{reason[0]}</div>
                        <div class="mt-0.5 opacity-80">{reason[1]}</div>
                    </li>
                {/each}
            </ul>
        </ShAlert>

        <details class="rounded-md border border-darkborderc bg-bgcolor/30 px-3 py-2 text-sm text-textcolor2">
            <summary class="cursor-pointer font-medium risu-interactive-foreground">Dev Info</summary>
            <div class="mt-2 flex flex-col gap-2">
                {#each pluginAlertModalStore.errors as error}
                    <p class="m-0 wrap-break-word">{error.message}</p>
                {/each}
            </div>
        </details>
    </ShDialog>
{/if}

{#snippet footerActions()}
    <ShButton variant="destructive" onclick={continueAnyway}>
        {language.continueAnyway}
    </ShButton>
    <ShButton variant="primary" onclick={rejectPlugin}>
        {language.doNotInstall}
    </ShButton>
{/snippet}
