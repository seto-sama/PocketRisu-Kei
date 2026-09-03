<script lang="ts">
    import Dialog from '../Dialog.svelte'
    import Select from '../Select.svelte'
    import SelectOption from '../SelectOption.svelte'
    import Portal from './Portal.svelte'
    import * as DropdownMenu from '../dropdown-menu';

    let open = $state(true)
    let value = $state('first')
    let menuSelections = $state(0)
</script>

<Dialog bind:open>
    {#snippet title()}Overlay test{/snippet}
    <Select bind:value>
        <SelectOption value="first">First</SelectOption>
        <SelectOption value="second">Second</SelectOption>
    </Select>
    <DropdownMenu.Root>
        <DropdownMenu.Trigger>
            {#snippet child({ props })}
                <button {...props} data-testid="menu-trigger">Menu</button>
            {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
            <DropdownMenu.Item onSelect={() => menuSelections++}>Select item</DropdownMenu.Item>
        </DropdownMenu.Content>
    </DropdownMenu.Root>
</Dialog>

<output data-testid="menu-selections">{menuSelections}</output>

<Portal>
    <div data-testid="plain-portal">Plain portal</div>
</Portal>
