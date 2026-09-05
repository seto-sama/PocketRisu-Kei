<script lang="ts">
    import { onDestroy, untrack } from 'svelte';
    import type { HTMLInputAttributes } from 'svelte/elements';
    import { cn } from 'src/lib/utils';
    import { createDebouncedDraftWriter } from 'src/ts/storage/draftPersistence';
    import { INPUT_COMMIT_DEBOUNCE_MS, type InputCommitMode } from 'src/ts/inputCommit';

    type InputEvent = Event & { currentTarget: EventTarget & HTMLInputElement };
    type InputFocusEvent = globalThis.FocusEvent & { currentTarget: EventTarget & HTMLInputElement };

    interface Props extends Omit<HTMLInputAttributes, 'class' | 'value' | 'size' | 'ref' | 'oninput' | 'onchange' | 'onfocus' | 'onblur' | 'onkeydown'> {
        ref?: HTMLInputElement | null;
        value?: string;
        size?: 'sm' | 'md' | 'lg' | 'xl';
        className?: string;
        padding?: boolean;
        marginBottom?: boolean;
        marginTop?: boolean;
        fullwidth?: boolean;
        fullh?: boolean;
        hideText?: boolean;
        commitMode?: InputCommitMode;
        debounceMs?: number;
        oncommit?: (value: string) => void;
        ondraft?: (value: string) => void;
        oninput?: (event: InputEvent) => void;
        onchange?: (event: InputEvent) => void;
        onfocus?: (event: InputFocusEvent) => void;
        onblur?: (event: InputFocusEvent) => void;
        onkeydown?: (event: KeyboardEvent) => void;
        ariaControls?: string;
        ariaExpanded?: 'true' | 'false';
        ariaAutocomplete?: 'none' | 'inline' | 'list' | 'both';
        ariaActiveDescendant?: string;
    }

    let {
        ref = $bindable(null),
        value = $bindable(),
        size = 'md',
        className = '',
        padding = true,
        marginBottom = false,
        marginTop = false,
        fullwidth = true,
        fullh = false,
        hideText = false,
        type = 'text',
        autocomplete,
        commitMode = 'input',
        debounceMs = INPUT_COMMIT_DEBOUNCE_MS,
        oncommit = () => {},
        ondraft = () => {},
        oninput,
        onchange,
        onfocus,
        onblur,
        onkeydown,
        ariaControls,
        ariaExpanded,
        ariaAutocomplete,
        ariaActiveDescendant,
        ...rest
    }: Props = $props();

    let draftValue = $state(untrack(() => value ?? ''));
    let dirty = $state(false);
    let composing = $state(false);

    const sizeClasses = {
        sm: 'h-8 min-h-8 text-sm',
        md: 'h-10 min-h-10 text-base',
        lg: 'h-11 min-h-11 text-base',
        xl: 'h-12 min-h-12 text-lg',
    };

    const classes = $derived(cn(
        'risu-field-border min-w-0 rounded-md bg-transparent text-maintext disabled:cursor-not-allowed disabled:opacity-50',
        padding && 'px-2.5 py-1',
        sizeClasses[size],
        fullwidth && 'w-full',
        fullh && 'h-full',
        marginBottom && 'mb-4',
        marginTop && 'mt-4',
        className,
    ));

    function commit(nextValue = draftValue) {
        writer.cancel();
        draftValue = nextValue;
        dirty = false;
        if (nextValue === (value ?? '')) return;
        value = nextValue;
        oncommit(nextValue);
    }

    const writer = createDebouncedDraftWriter<string>((nextValue) => {
        if (!composing) commit(nextValue);
    }, untrack(() => debounceMs));

    function scheduleCommit() {
        if (composing) return;
        if (commitMode === 'input') commit();
        else if (commitMode === 'debounce') writer.schedule(draftValue);
    }

    function handleInput(event: InputEvent) {
        draftValue = event.currentTarget.value;
        dirty = draftValue !== (value ?? '');
        ondraft(draftValue);
        scheduleCommit();
        oninput?.(event);
    }

    function handleChange(event: InputEvent) {
        if (commitMode !== 'input') commit();
        onchange?.(event);
    }

    function handleBlur(event: InputFocusEvent) {
        if (commitMode !== 'input') commit();
        onblur?.(event);
    }

    function handleKeydown(event: KeyboardEvent) {
        if (!composing && event.key === 'Enter' && commitMode !== 'input') commit();
        if (!composing && event.key === 'Escape' && dirty) {
            writer.cancel();
            draftValue = value ?? '';
            dirty = false;
            ondraft(draftValue);
        }
        onkeydown?.(event);
    }

    function handleCompositionEnd(event: CompositionEvent & { currentTarget: HTMLInputElement }) {
        composing = false;
        draftValue = event.currentTarget.value;
        dirty = draftValue !== (value ?? '');
        ondraft(draftValue);
        scheduleCommit();
    }

    $effect(() => {
        const externalValue = value ?? '';
        if (!dirty && externalValue !== draftValue) draftValue = externalValue;
    });

    onDestroy(() => {
        if (dirty) commit();
        else writer.cancel();
    });
</script>

<input
    bind:this={ref}
    type={hideText ? 'password' : type}
    autocomplete={hideText ? 'new-password' : autocomplete}
    value={draftValue}
    class={classes}
    data-slot="input"
    oninput={handleInput}
    onchange={handleChange}
    onfocus={onfocus}
    onblur={handleBlur}
    onkeydown={handleKeydown}
    oncompositionstart={() => (composing = true)}
    oncompositionend={handleCompositionEnd}
    aria-controls={ariaControls}
    aria-expanded={ariaExpanded}
    aria-autocomplete={ariaAutocomplete}
    aria-activedescendant={ariaActiveDescendant}
    {...rest}
/>
