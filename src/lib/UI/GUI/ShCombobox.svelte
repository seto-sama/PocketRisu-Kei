<script lang="ts" module>
    let comboboxIdCounter = 0;
</script>

<script lang="ts">
    import { tick } from 'svelte';
    import TextInput from './TextInput.svelte';
    import Portal from './Portal.svelte';

    interface Props {
        value: string;
        options: readonly string[];
        placeholder?: string;
        size?: 'sm' | 'md' | 'lg' | 'xl';
        className?: string;
        containerClassName?: string;
        marginBottom?: boolean;
        disabled?: boolean;
    }

    let {
        value = $bindable(),
        options,
        placeholder = '',
        size = 'md',
        className = '',
        containerClassName = 'w-full',
        marginBottom = false,
        disabled = false,
    }: Props = $props();

    const comboboxId = `sh-combobox-${++comboboxIdCounter}`;
    const listboxId = `${comboboxId}-listbox`;
    const uniqueOptions = $derived([...new Set(options.filter(Boolean))]);
    const filteredOptions = $derived.by(() => {
        const query = String(value ?? '').trim().toLowerCase();
        if (!query) return uniqueOptions;
        return uniqueOptions.filter(option => option.toLowerCase().includes(query));
    });

    let rootEl: HTMLDivElement | undefined = $state();
    let dropdownEl: HTMLDivElement | undefined = $state();
    let open = $state(false);
    let highlightedIndex = $state(0);
    let dropdownStyle = $state('');
    const listVisible = $derived(open && filteredOptions.length > 0);
    const activeDescendant = $derived(
        listVisible && filteredOptions[highlightedIndex]
            ? `${comboboxId}-option-${highlightedIndex}`
            : undefined,
    );

    function inputElement(): HTMLInputElement | null {
        return rootEl?.querySelector('input') ?? null;
    }

    async function positionDropdown() {
        await tick();
        const input = inputElement();
        if (!input || !dropdownEl || !listVisible) return;

        const rect = input.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;
        const dropdownHeight = dropdownEl.offsetHeight;

        if (spaceBelow >= dropdownHeight || spaceBelow >= spaceAbove) {
            dropdownStyle = `top: ${rect.bottom + 2}px; left: ${rect.left}px; width: ${rect.width}px;`;
        } else {
            dropdownStyle = `bottom: ${window.innerHeight - rect.top + 2}px; left: ${rect.left}px; width: ${rect.width}px;`;
        }
    }

    function openDropdown() {
        if (disabled) return;
        open = true;
        const exactIndex = filteredOptions.findIndex(
            option => option.toLowerCase() === String(value ?? '').trim().toLowerCase(),
        );
        highlightedIndex = exactIndex >= 0 ? exactIndex : 0;
        void positionDropdown();
    }

    function closeDropdown() {
        open = false;
        highlightedIndex = 0;
    }

    function selectOption(option: string) {
        value = option;
        closeDropdown();
        void tick().then(() => inputElement()?.focus());
    }

    function handleInput() {
        open = true;
        highlightedIndex = 0;
        void positionDropdown();
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            closeDropdown();
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (!open) {
                openDropdown();
                return;
            }
            highlightedIndex = Math.min(highlightedIndex + 1, filteredOptions.length - 1);
            dropdownEl
                ?.querySelector<HTMLElement>(`#${comboboxId}-option-${highlightedIndex}`)
                ?.scrollIntoView({ block: 'nearest' });
            return;
        }

        if (event.key === 'ArrowUp' && open) {
            event.preventDefault();
            highlightedIndex = Math.max(highlightedIndex - 1, 0);
            dropdownEl
                ?.querySelector<HTMLElement>(`#${comboboxId}-option-${highlightedIndex}`)
                ?.scrollIntoView({ block: 'nearest' });
            return;
        }

        if (event.key === 'Enter' && listVisible) {
            const option = filteredOptions[highlightedIndex];
            if (option) {
                event.preventDefault();
                selectOption(option);
            }
        }
    }

    function handlePointerDown(event: PointerEvent) {
        const target = event.target as Node;
        if (open && rootEl && !rootEl.contains(target) && !dropdownEl?.contains(target)) {
            closeDropdown();
        }
    }

    $effect(() => {
        if (!open) return;

        document.addEventListener('pointerdown', handlePointerDown, true);
        window.addEventListener('resize', positionDropdown);
        window.addEventListener('scroll', positionDropdown, true);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown, true);
            window.removeEventListener('resize', positionDropdown);
            window.removeEventListener('scroll', positionDropdown, true);
        };
    });
</script>

<div bind:this={rootEl} class="relative {containerClassName}">
    <TextInput
        bind:value
        {size}
        {placeholder}
        {className}
        {marginBottom}
        {disabled}
        fullwidth
        autocomplete="off"
        role="combobox"
        ariaControls={listboxId}
        ariaExpanded={listVisible ? 'true' : 'false'}
        ariaAutocomplete="list"
        ariaActiveDescendant={activeDescendant}
        onfocus={openDropdown}
        oninput={handleInput}
        onkeydown={handleKeydown}
    />

    {#if listVisible}
        <Portal>
        <div
            bind:this={dropdownEl}
            id={listboxId}
            role="listbox"
            class="fixed z-[100] max-h-64 overflow-y-auto rounded-md border border-darkborderc
                   bg-darkbg shadow-lg p-1"
            style={dropdownStyle}
        >
            {#each filteredOptions as option, index}
                <button
                    id={`${comboboxId}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={option === value}
                    class="block w-full truncate rounded px-2 py-1.5 text-left text-sm text-textcolor
                           {index === highlightedIndex ? 'bg-selected' : 'risu-interactive-surface-strong'}"
                    onmouseenter={() => highlightedIndex = index}
                    onclick={() => selectOption(option)}
                >
                    {option}
                </button>
            {/each}
        </div>
        </Portal>
    {/if}
</div>
