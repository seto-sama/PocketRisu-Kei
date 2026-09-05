<script lang="ts">
    import { onDestroy, untrack } from 'svelte';
    import { cn } from 'src/lib/utils';
    import { createDebouncedDraftWriter } from 'src/ts/storage/draftPersistence';
    import { INPUT_COMMIT_DEBOUNCE_MS, type InputCommitMode } from 'src/ts/inputCommit';

    interface Props {
        min?: number;
        max?: number;
        step?: number;
        size?: 'sm' | 'md' | 'lg';
        value?: number;
        allowEmpty?: boolean;
        id?: string;
        padding?: boolean;
        marginBottom?: boolean;
        fullwidth?: boolean;
        fullh?: boolean;
        onChange?: (event: Event & { currentTarget: EventTarget & HTMLInputElement }) => void;
        onCommit?: (value: number | undefined) => void;
        commitMode?: InputCommitMode;
        debounceMs?: number;
        className?: string;
        disabled?: boolean;
        placeholder?: string;
        ariaLabel?: string;
    }

    let {
        min,
        max,
        step,
        size = 'md',
        value = $bindable(),
        allowEmpty = false,
        id,
        padding = true,
        marginBottom = false,
        fullwidth = false,
        fullh = false,
        onChange = () => {},
        onCommit = () => {},
        commitMode = 'blur',
        debounceMs = INPUT_COMMIT_DEBOUNCE_MS,
        className = '',
        disabled = false,
        placeholder,
        ariaLabel,
    }: Props = $props();

    let draftValue = $state(untrack(() => String(value ?? '')));
    let dirty = $state(false);

    const sizeClasses = {
        sm: 'px-2 py-1 text-sm',
        md: 'px-4 py-2 text-base',
        lg: 'px-6 py-3 text-lg',
    };

    function normalizedDraft(): number | null {
        if (draftValue.trim() === '') return null;
        const parsed = Number(draftValue);
        if (!Number.isFinite(parsed)) return null;
        return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed));
    }

    function revert() {
        writer.cancel();
        draftValue = String(value ?? '');
        dirty = false;
    }

    function commit() {
        writer.cancel();
        const nextValue = normalizedDraft();
        if (nextValue === null) {
            if (allowEmpty) {
                draftValue = '';
                dirty = false;
                if (value === undefined) return;
                value = undefined;
                onCommit(undefined);
                return;
            }
            revert();
            return;
        }
        draftValue = String(nextValue);
        dirty = false;
        if (nextValue === value) return;
        value = nextValue;
        onCommit(nextValue);
    }

    const writer = createDebouncedDraftWriter<void>(() => commit(), untrack(() => debounceMs));

    function scheduleCommit() {
        if (commitMode === 'input') commit();
        else if (commitMode === 'debounce') writer.schedule();
    }

    function handleInput(event: Event & { currentTarget: HTMLInputElement }) {
        draftValue = event.currentTarget.value;
        dirty = draftValue !== String(value ?? '');
        scheduleCommit();
    }

    function handleChange(event: Event & { currentTarget: HTMLInputElement }) {
        if (commitMode !== 'input') commit();
        onChange(event);
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter') commit();
        else if (event.key === 'Escape' && dirty) revert();
    }

    $effect(() => {
        const externalValue = String(value ?? '');
        if (!dirty && externalValue !== draftValue) draftValue = externalValue;
    });

    onDestroy(() => {
        if (dirty) commit();
        else writer.cancel();
    });
</script>

<input
    type="number"
    {min}
    {max}
    {step}
    {id}
    {disabled}
    value={draftValue}
    oninput={handleInput}
    onchange={handleChange}
    onblur={() => commitMode !== 'input' && commit()}
    onkeydown={handleKeydown}
    {placeholder}
    aria-label={ariaLabel}
    data-slot="number-input"
    class={cn(
        'risu-field-border numinput rounded-md bg-transparent shadow-xs disabled:cursor-not-allowed',
        disabled ? 'text-subtext' : 'text-maintext',
        padding && sizeClasses[size],
        !padding && sizeClasses[size].split(' ').filter(token => !token.startsWith('px-') && !token.startsWith('py-')).join(' '),
        marginBottom && 'mb-4',
        fullwidth && 'w-full',
        fullh && 'h-full',
        className,
    )}
/>

<style>
    .numinput::-webkit-outer-spin-button,
    .numinput::-webkit-inner-spin-button {
        appearance: none;
        -webkit-appearance: none;
        margin: 0;
    }
    .numinput {
        appearance: textfield;
        -moz-appearance: textfield;
    }
</style>
