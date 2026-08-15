
<!-- Since svelte doesn't allow two-way binding for dynamic types, we use this -->

{#if hideText}
     <!-- new-password disables autofill -->
    <input 
        class={"risu-field-border peer rounded-md shadow-xs text-textcolor bg-transparent" + ((className) ? (' ' + className) : '')}
        class:text-sm={size === 'sm'}
        class:text-md={size === 'md'}
        class:text-lg={size === 'lg'}
        class:text-xl={size === 'xl'}

        class:px-4={size === 'md' && padding}
        class:py-2={size === 'md' && padding}
        class:px-2={size === 'sm' && padding}
        class:py-1={size === 'sm' && padding}
        class:px-6={size === 'lg' || size === 'xl' && padding}
        class:py-3={size === 'lg' || size === 'xl'&& padding}

        class:mb-4={marginBottom}
        class:mt-4={marginTop}
        class:w-full={fullwidth}
        class:h-full={fullh}
        class:text-textcolor2={disabled}

        autocomplete="new-password"
        {placeholder}
        id={id}
        type="password"
        bind:value
        disabled={disabled}
        oninput={oninput}
        onchange={onchange}
        onkeydown={onkeydown}
        onfocus={onfocus}
        list={list}
        {role}
        aria-controls={ariaControls}
        aria-expanded={ariaExpanded}
        aria-autocomplete={ariaAutocomplete}
        aria-activedescendant={ariaActiveDescendant}
    />
{:else}

    <input 
        class={"risu-field-border peer rounded-md shadow-xs text-textcolor bg-transparent" + ((className) ? (' ' + className) : '')}
        list={list}
        class:text-sm={size === 'sm'}
        class:text-md={size === 'md'}
        class:text-lg={size === 'lg'}
        class:text-xl={size === 'xl'}

        class:px-4={size === 'md' && padding}
        class:py-2={size === 'md' && padding}
        class:px-2={size === 'sm' && padding}
        class:py-1={size === 'sm' && padding}
        class:px-6={size === 'lg' || size === 'xl' && padding}
        class:py-3={size === 'lg' || size === 'xl'&& padding}

        class:mb-4={marginBottom}
        class:mt-4={marginTop}
        class:w-full={fullwidth}
        class:h-full={fullh}
        class:text-textcolor2={disabled}

        {autocomplete}
        {placeholder}
        id={id}
        type="text"
        bind:value
        disabled={disabled}
        oninput={oninput}
        onchange={onchange}
        onkeydown={onkeydown}
        onfocus={onfocus}
        {role}
        aria-controls={ariaControls}
        aria-expanded={ariaExpanded}
        aria-autocomplete={ariaAutocomplete}
        aria-activedescendant={ariaActiveDescendant}
    />
{/if}

<script lang="ts">
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
</script>

<style>
    .hide-text:not(:focus):not(:hover) {
        text-indent: -9999px;
    }
</style>
