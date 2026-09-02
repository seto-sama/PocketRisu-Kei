<input 
    class={"risu-field-border rounded-md shadow-xs bg-transparent numinput" + ((className) ? (' ' + className) : '')}
    class:text-sm={size === 'sm'}
    class:text-md={size === 'md'}
    class:text-lg={size === 'lg'}
    class:text-textcolor={!disabled}
    class:text-textcolor2={disabled}
    class:px-4={size === 'md' && padding}
    class:py-2={size === 'md' && padding}
    class:px-2={size === 'sm' && padding}
    class:py-1={size === 'sm' && padding}
    class:px-6={size === 'lg' && padding}
    class:py-3={size === 'lg' && padding}
    class:mb-4={marginBottom}
    class:w-full={fullwidth}
    class:h-full={fullh}
    type="number"
    min={min}
    max={max}
    id={id}
    disabled={disabled}
    value={draftValue}
    oninput={handleInput}
    onchange={handleChange}
    onblur={handleBlur}
    onkeydown={handleKeydown}
    placeholder={placeholder}
/>

<script lang="ts">
    import { onDestroy, untrack } from 'svelte';
    import { createDebouncedDraftWriter } from 'src/ts/storage/draftPersistence';
    import { INPUT_COMMIT_DEBOUNCE_MS, type InputCommitMode } from 'src/ts/inputCommit';

    interface Props {
        min?: number;
        max?: number;
        size?: 'sm'|'md'|'lg';
        value: number;
        id?: string;
        padding?: boolean;
        marginBottom?: boolean;
        fullwidth?: boolean;
        fullh?: boolean;
        onChange?: (event: Event & {
            currentTarget: EventTarget & HTMLInputElement;
        }) => any;
        onCommit?: (value: number) => void;
        commitMode?: InputCommitMode;
        debounceMs?: number;
        className?: string;
        disabled?: boolean;
        placeholder?: string;
    }

    let {
        min = undefined,
        max = undefined,
        size = 'md',
        value = $bindable(),
        id = undefined,
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
        placeholder
    }: Props = $props();

    let draftValue = $state(untrack(() => String(value ?? '')));
    let dirty = $state(false);

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

    function handleBlur() {
        if (commitMode !== 'input') commit();
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

<style>
    .numinput::-webkit-outer-spin-button,
    .numinput::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
    }

    /* Firefox */
    .numinput {
        -moz-appearance: textfield;
        appearance: textfield;
    }
</style>
