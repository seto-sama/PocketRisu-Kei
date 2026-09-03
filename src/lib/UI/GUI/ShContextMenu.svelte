<script lang="ts">
    import { ContextMenu } from 'bits-ui';
    import { provideOverlayLayer } from 'src/ts/gui/overlayLayer.svelte';

    let { open = $bindable(false), ...restProps }: ContextMenu.RootProps = $props();

    provideOverlayLayer(() => open);
</script>

<ContextMenu.Root bind:open {...restProps} />

