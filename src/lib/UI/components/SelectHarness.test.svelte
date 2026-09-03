<script lang="ts">
    import Select from './Select.svelte'
    import SelectOption from './SelectOption.svelte'

    let value = $state('first')
    let changes = $state(0)
</script>

<Select bind:value onchange={() => changes++}>
    <SelectOption value="first">First</SelectOption>
    <SelectOption value="second">Second</SelectOption>
</Select>

<output data-testid="value">{value}</output>
<output data-testid="changes">{changes}</output>
