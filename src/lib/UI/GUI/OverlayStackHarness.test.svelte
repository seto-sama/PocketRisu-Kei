<script lang="ts">
    import ShDialog from './ShDialog.svelte'
    import ShSelect from './ShSelect.svelte'
    import OptionInput from './OptionInput.svelte'
    import Portal from './Portal.svelte'
    import ShDropdownMenu from './ShDropdownMenu.svelte'
    import ShDropdownMenuContent from './ShDropdownMenuContent.svelte'
    import ShDropdownMenuItem from './ShDropdownMenuItem.svelte'
    import ShDropdownMenuTrigger from './ShDropdownMenuTrigger.svelte'

    let open = $state(true)
    let value = $state('first')
    let menuSelections = $state(0)
</script>

<ShDialog bind:open>
    {#snippet title()}Overlay test{/snippet}
    <ShSelect bind:value>
        <OptionInput value="first">First</OptionInput>
        <OptionInput value="second">Second</OptionInput>
    </ShSelect>
    <ShDropdownMenu>
        <ShDropdownMenuTrigger>
            {#snippet child({ props })}
                <button {...props} data-testid="menu-trigger">Menu</button>
            {/snippet}
        </ShDropdownMenuTrigger>
        <ShDropdownMenuContent>
            <ShDropdownMenuItem onSelect={() => menuSelections++}>Select item</ShDropdownMenuItem>
        </ShDropdownMenuContent>
    </ShDropdownMenu>
</ShDialog>

<output data-testid="menu-selections">{menuSelections}</output>

<Portal>
    <div data-testid="plain-portal">Plain portal</div>
</Portal>
