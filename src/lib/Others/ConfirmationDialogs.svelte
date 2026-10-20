<script lang="ts">
    import { language } from 'src/lang';
    import { confirmationDialogs } from 'src/ts/alert';
    import { openURL } from 'src/ts/globalApi.svelte';
    import Button from '../UI/components/Button.svelte';
    import Dialog from '../UI/components/Dialog.svelte';
</script>

{#each $confirmationDialogs as dialog (dialog.id)}
    {#snippet heading()}
        {dialog.kind === 'terms' ? language.risuTosTitle : dialog.kind === 'multi' ? dialog.message : ''}
    {/snippet}
    <Dialog
        open={true}
        role="alertdialog"
        closable={false}
        ariaLabel={language.confirm}
        title={dialog.kind === 'confirm' ? undefined : heading}
        onConfirm={dialog.kind === 'multi' ? undefined : () => dialog.complete(true)}
        onOpenChange={(open) => { if (!open) dialog.complete(dialog.kind === 'multi' ? -1 : false) }}
    >
        {#if dialog.kind === 'terms'}
            <div class="flex flex-col gap-3">
                <p>{language.risuTosDesc}</p>
                <p class="text-sm text-subtext">{language.risuTosScope}</p>
                <ul class="list-disc pl-5 text-sm text-subtext">
                    <li>{language.risuTosScopeRealm}</li><li>{language.risuTosScopeMcp}</li>
                </ul>
                <div class="flex flex-wrap gap-3">
                    <Button variant="link" onclick={() => openURL('https://account.sionyw.com/terms')}>{language.risuTosTerms}</Button>
                    <Button variant="link" onclick={() => openURL('https://account.sionyw.com/privacy')}>{language.risuTosPrivacy}</Button>
                </div>
            </div>
        {:else}
            <div class="flex flex-col gap-2">
                {#if dialog.kind === 'confirm'}
                    <span>{dialog.message}</span>
                {/if}
                {#if dialog.description}
                    <span class="text-sm text-subtext">{dialog.description}</span>
                {/if}
                {#if dialog.kind === 'multi'}
                    {#each dialog.actions as action, index}
                        <Button variant={action.variant ?? 'default'} className="w-full" onclick={() => dialog.complete(index)}>{action.label}</Button>
                    {/each}
                {/if}
            </div>
        {/if}
        {#snippet footer()}
            <Button variant="outline" onclick={() => dialog.complete(dialog.kind === 'multi' ? -1 : false)}>
                {dialog.kind === 'terms' ? language.risuTosDecline : dialog.kind === 'multi' ? language.cancel : language.no}
            </Button>
            {#if dialog.kind !== 'multi'}
                <Button onclick={() => dialog.complete(true)}>{dialog.kind === 'terms' ? language.risuTosAccept : language.yes}</Button>
            {/if}
        {/snippet}
    </Dialog>
{/each}
