<script lang="ts">
    // shadcn-svelte DropdownMenu Trigger — pass through to bits-ui.
    // The trigger element style (button, icon, etc.) is the caller's
    // responsibility; this component only wires up the open/close behavior.
    import { DropdownMenu } from 'bits-ui';

    let { ref = $bindable(null), ...restProps }: DropdownMenu.TriggerProps = $props();
</script>

<DropdownMenu.Trigger bind:ref data-slot="dropdown-menu-trigger" {...restProps} />
