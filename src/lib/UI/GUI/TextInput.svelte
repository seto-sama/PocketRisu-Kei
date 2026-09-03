
<!-- Since svelte doesn't allow two-way binding for dynamic types, we use this -->

{#if hideText}
     <!-- new-password disables autofill -->
    <input 
        class={"risu-field-border peer rounded-md shadow-xs text-maintext bg-transparent" + ((className) ? (' ' + className) : '')}
        class:text-sm={size === 'sm'}
        class:text-md={size === 'md'}
        class:text-lg={size === 'lg'}
        class:text-xl={size === 'xl'}

        class:risu-single-line-input={padding}
        class:py-2={size === 'md' && padding}
        class:py-1={size === 'sm' && padding}
        class:py-3={size === 'lg' || size === 'xl'&& padding}

        class:mb-4={marginBottom}
        class:mt-4={marginTop}
        class:w-full={fullwidth}
        class:h-full={fullh}
        class:text-subtext={disabled}

        autocomplete="new-password"
        {placeholder}
        id={id}
        type="password"
        value={draftValue}
        disabled={disabled}
        oninput={handleInput}
        onchange={handleChange}
        onkeydown={handleKeydown}
        onfocus={handleFocus}
        onblur={handleBlur}
        oncompositionstart={() => composing = true}
        oncompositionend={handleCompositionEnd}
        list={list}
        {role}
        aria-controls={ariaControls}
        aria-expanded={ariaExpanded}
        aria-autocomplete={ariaAutocomplete}
        aria-activedescendant={ariaActiveDescendant}
    />
{:else}

    <input 
        class={"risu-field-border peer rounded-md shadow-xs text-maintext bg-transparent" + ((className) ? (' ' + className) : '')}
        list={list}
        class:text-sm={size === 'sm'}
        class:text-md={size === 'md'}
        class:text-lg={size === 'lg'}
        class:text-xl={size === 'xl'}

        class:risu-single-line-input={padding}
        class:py-2={size === 'md' && padding}
        class:py-1={size === 'sm' && padding}
        class:py-3={size === 'lg' || size === 'xl'&& padding}

        class:mb-4={marginBottom}
        class:mt-4={marginTop}
        class:w-full={fullwidth}
        class:h-full={fullh}
        class:text-subtext={disabled}

        {autocomplete}
        {placeholder}
        id={id}
        type="text"
        value={draftValue}
        disabled={disabled}
        oninput={handleInput}
        onchange={handleChange}
        onkeydown={handleKeydown}
        onfocus={handleFocus}
        onblur={handleBlur}
        oncompositionstart={() => composing = true}
        oncompositionend={handleCompositionEnd}
        {role}
        aria-controls={ariaControls}
        aria-expanded={ariaExpanded}
        aria-autocomplete={ariaAutocomplete}
        aria-activedescendant={ariaActiveDescendant}
    />
{/if}

<script lang="ts">
    import { onDestroy, untrack } from 'svelte';
    import { createDebouncedDraftWriter } from 'src/ts/storage/draftPersistence';
    import { INPUT_COMMIT_DEBOUNCE_MS, type InputCommitMode } from 'src/ts/inputCommit';

    type FormEventHandler<T extends EventTarget> = (event: Event & {
        currentTarget: EventTarget & T;
    }) => any

    interface Props {
        size?: 'sm'|'md'|'lg'|'xl';
        autocomplete?: 'on'|'off';
        placeholder?: string;
        value: string;
        id?: string;
        padding?: boolean;
        marginBottom?: boolean;
        marginTop?: boolean;
        oninput?: FormEventHandler<HTMLInputElement>
        onchange?: FormEventHandler<HTMLInputElement>;
        onkeydown?: (event: KeyboardEvent) => any;
        onfocus?: FormEventHandler<HTMLInputElement>;
        onblur?: FormEventHandler<HTMLInputElement>;
        oncommit?: (value: string) => void;
        ondraft?: (value: string) => void;
        commitMode?: InputCommitMode;
        debounceMs?: number;
        fullwidth?: boolean;
        fullh?: boolean;
        className?: string;
        disabled?: boolean;
        hideText?: boolean;
        list?: string;
        role?: string;
        ariaControls?: string;
        ariaExpanded?: 'true' | 'false';
        ariaAutocomplete?: 'none' | 'inline' | 'list' | 'both';
        ariaActiveDescendant?: string;
    }

    let {
        size = 'md',
        autocomplete = 'off',
        placeholder = '',
        value = $bindable(),
        id = undefined,
        padding = true,
        marginBottom = false,
        marginTop = false,
        oninput,
        onchange,
        onkeydown,
        onfocus,
        onblur,
        oncommit = () => {},
        ondraft = () => {},
        commitMode = 'input',
        debounceMs = INPUT_COMMIT_DEBOUNCE_MS,
        fullwidth = false,
        fullh = false,
        className = '',
        disabled = false,
        hideText = false,
        list = undefined,
        role = undefined,
        ariaControls = undefined,
        ariaExpanded = undefined,
        ariaAutocomplete = undefined,
        ariaActiveDescendant = undefined
        
    }: Props = $props();

    let draftValue = $state(untrack(() => value ?? ''));
    let dirty = $state(false);
    let composing = $state(false);

    function commit(nextValue = draftValue) {
        writer.cancel();
        draftValue = nextValue;
        dirty = false;
        if (nextValue === value) return;
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

    function handleInput(event: Event & { currentTarget: HTMLInputElement }) {
        draftValue = event.currentTarget.value;
        dirty = draftValue !== value;
        ondraft(draftValue);
        scheduleCommit();
        oninput?.(event);
    }

    function handleChange(event: Event & { currentTarget: HTMLInputElement }) {
        if (commitMode !== 'input') commit();
        onchange?.(event);
    }

    function handleFocus(event: FocusEvent & { currentTarget: HTMLInputElement }) {
        onfocus?.(event);
    }

    function handleBlur(event: FocusEvent & { currentTarget: HTMLInputElement }) {
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
        dirty = draftValue !== value;
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

<style>
    .risu-single-line-input {
        padding-inline: 0.625rem;
    }

    .hide-text:not(:focus):not(:hover) {
        text-indent: -9999px;
    }
</style>
