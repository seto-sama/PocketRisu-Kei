<script lang="ts" module>
    export type ApiKeyInputMode = 'pool' | 'direct';

    export function getInitialApiKeyInputMode(
        selectedId: string | undefined,
        directValue: unknown,
    ): ApiKeyInputMode {
        if (selectedId) return 'pool';
        return typeof directValue === 'string' && directValue.length > 0
            ? 'direct'
            : 'pool';
    }
</script>

<script lang="ts">
    import { KeyRoundIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import Button from "../UI/components/Button.svelte";
    import Select from "../UI/components/Select.svelte";
    import SelectOption from "../UI/components/SelectOption.svelte";
    import SecretInput from "../UI/components/SecretInput.svelte";
    import type { ApiKeyPoolEntry } from "src/ts/preset/types";

    interface Props {
        mode: ApiKeyInputMode;
        entries: ApiKeyPoolEntry[];
        selectedId?: string;
        directValue: string;
        onSelect?: (id: string) => void;
        placeholder?: string;
        showProvider?: boolean;
        showSaveDirect?: boolean;
        onSaveDirect?: () => void;
    }

    let {
        mode = $bindable(),
        entries,
        selectedId = '',
        directValue = $bindable(),
        onSelect = () => {},
        placeholder = '',
        showProvider = false,
        showSaveDirect = false,
        onSaveDirect = () => {},
    }: Props = $props();

    const danglingRef = $derived(
        !!selectedId && !entries.some(entry => entry.id === selectedId)
    );

    function toggleMode() {
        if (mode === 'pool') {
            onSelect('');
            mode = 'direct';
        } else {
            onSelect(entries[0]?.id ?? '');
            mode = 'pool';
        }
    }
</script>

<div class="flex shrink-0 items-start gap-2 self-end">
    <Button
        variant={mode === 'pool' ? 'primary' : 'outline'}
        size="icon-sm"
        aria-label={language.apiKeyModePool}
        aria-pressed={mode === 'pool'}
        title={language.apiKeyModePool}
        onclick={toggleMode}
    >
        <KeyRoundIcon />
    </Button>

    <div class="w-48">
        {#if mode === 'pool'}
            {#if entries.length === 0 && !danglingRef}
                <div class="flex h-8 items-center text-xs text-subtext">{language.apiKeyPoolEmpty}</div>
            {:else}
                <Select className="w-48" size="sm" value={selectedId} onchange={(event) => onSelect(String(event.currentTarget.value))}>
                    <SelectOption value="">{language.apiKeySelectNone}</SelectOption>
                    {#if danglingRef}
                        <SelectOption value={selectedId}>{language.apiKeyDeletedOption}</SelectOption>
                    {/if}
                    {#each entries as entry (entry.id)}
                        <SelectOption value={entry.id}>{entry.name}{showProvider && entry.provider ? ` (${entry.provider})` : ''}</SelectOption>
                    {/each}
                </Select>
            {/if}
        {:else}
            <SecretInput
                bind:value={directValue}
                {placeholder}
                className="h-8 px-2.5 py-0 text-sm"
                fullwidth
            />
            {#if showSaveDirect}
                <div class="flex justify-end mt-1">
                    <Button variant="ghost" size="sm" onclick={onSaveDirect}>
                        {language.apiKeySave}
                    </Button>
                </div>
            {/if}
        {/if}
    </div>
</div>
