<script lang="ts">
    import { updatePopupStore, dismissUpdatePopup, type UpdateInfo } from "src/ts/update";
    import { language } from "src/lang";
    import { ArrowUpCircleIcon, CopyIcon, CheckIcon } from "@lucide/svelte";
    import ProgressDialog from "../UI/components/ProgressDialog.svelte";
    import Button from "../UI/components/Button.svelte";
    import Help from "./Help.svelte";

    const info: UpdateInfo | null = $derived($updatePopupStore);

    // Titles are language keys, resolved at render: this component mounts before the saved language loads.
    const updateCommands = [
        { titleKey: 'updatePopupGitTitle', helpKey: 'updatePopupGit', command: 'git pull && pnpm install && pnpm build' },
        { titleKey: 'updatePopupDockerTitle', helpKey: 'updatePopupDocker', command: 'docker compose pull && docker compose up -d' },
    ] as const;

    let copiedCommand = $state<string | null>(null);

    async function copyCommand(command: string) {
        try {
            await navigator.clipboard.writeText(command);
            copiedCommand = command;
            setTimeout(() => { if (copiedCommand === command) copiedCommand = null; }, 2000);
        } catch {}
    }

</script>

{#if info}
    <ProgressDialog
        open={true}
        title={language.updatePopupTitle}
        icon={statusIcon}
        footer={footerActions}
    >
        <p class="text-sm text-maintext">
            {language.updatePopupNewVersion(info.latestVersion)}
        </p>
        <p class="mt-1 text-sm text-subtext">
            {language.updatePopupCurrentVersion.replace('{{current}}', info.currentVersion)}
        </p>

        {#if info.releaseNotes}
            <div class="mt-2 max-h-48 overflow-y-auto whitespace-pre-line text-sm text-subtext leading-relaxed">
                {info.releaseNotes}
            </div>
        {/if}

        <div class="mt-3 border-t border-darkborderc pt-3 flex flex-col gap-3">
            {#each updateCommands as { titleKey, helpKey, command } (command)}
                <div class="flex flex-col gap-1">
                    <span class="text-sm font-semibold text-maintext">
                        {language[titleKey]}<Help key={helpKey} name={language[titleKey]} />
                    </span>
                    <div class="flex items-center gap-1">
                        <code class="min-w-0 overflow-x-auto whitespace-nowrap text-xs text-maintext select-all">{command}</code>
                        <Button variant="ghost" size="icon-xs" className="shrink-0" onclick={() => copyCommand(command)} aria-label={copiedCommand === command ? language.copied : language.copy}>
                            {#if copiedCommand === command}
                                <CheckIcon />
                            {:else}
                                <CopyIcon />
                            {/if}
                        </Button>
                    </div>
                </div>
            {/each}
        </div>
    </ProgressDialog>
{/if}

{#snippet statusIcon()}
    <span class="p-2 rounded-full bg-success/20 shrink-0" aria-hidden="true">
        <ArrowUpCircleIcon size={20} class="text-success" />
    </span>
{/snippet}

{#snippet footerActions()}
    <Button variant="outline" onclick={dismissUpdatePopup}>
        {language.close}
    </Button>
{/snippet}
