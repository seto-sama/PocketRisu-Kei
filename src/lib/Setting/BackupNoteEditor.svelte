<script lang="ts">
    import Button from '../UI/components/Button.svelte'
    import Dialog from '../UI/components/Dialog.svelte'
    import Input from '../UI/components/Input.svelte'
    import { language } from 'src/lang'

    interface Props {
        open?: boolean
        value: string
        title?: string
        description?: string
        allowEmpty?: boolean
        onSave: (value: string) => void | Promise<void>
    }

    let {
        open = $bindable(false),
        value,
        title: dialogTitle = language.backupNoteEdit,
        description: dialogDescription = language.backupNoteDescription,
        allowEmpty = true,
        onSave,
    }: Props = $props()
    let draft = $state('')
    let noteInput = $state<HTMLInputElement | null>(null)
    let saving = $state(false)
    let error = $state<string | null>(null)

    $effect(() => {
        if (!open) return
        draft = value
        error = null
    })

    async function save() {
        if (saving) return
        if (!allowEmpty && !draft.trim()) {
            error = language.backupNoteRequired
            return
        }
        saving = true
        error = null
        try {
            await onSave(draft)
            open = false
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        } finally {
            saving = false
        }
    }

    function focusNoteInput(event: Event) {
        event.preventDefault()
        noteInput?.focus()
    }
</script>

<Dialog
    bind:open
    size="sm"
    dismissible={!saving}
    closable={!saving}
    onOpenAutoFocus={focusNoteInput}
>
    {#snippet title()}{dialogTitle}{/snippet}
    {#snippet description()}{dialogDescription}{/snippet}

    <Input
        bind:ref={noteInput}
        bind:value={draft}
        maxlength={200}
        placeholder={language.backupNotePlaceholder}
        disabled={saving}
        onkeydown={(event) => {
            if (event.key === 'Enter' && !event.isComposing) {
                event.preventDefault()
                save()
            }
        }}
    />
    {#if error}<p class="mt-2 text-sm text-danger">{language.backupNoteSaveFailed}: {error}</p>{/if}

    {#snippet footer()}
        <Button variant="outline" disabled={saving} onclick={() => open = false}>{language.cancel}</Button>
        <Button disabled={saving} onclick={save}>{language.confirm}</Button>
    {/snippet}
</Dialog>
