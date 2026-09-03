<script lang="ts">
    import { Toaster as SonnerToaster, type ToasterProps } from 'svelte-sonner';
    import { isTouchDevice } from 'src/ts/stores.svelte';
    import { ColorSchemeTypeStore } from 'src/ts/gui/colorscheme';

    let { ...rest }: ToasterProps = $props();

    const position = $derived<ToasterProps['position']>($isTouchDevice ? 'top-center' : 'top-right');
</script>

<SonnerToaster
    theme={$ColorSchemeTypeStore}
    class="risu-toaster"
    {position}
    richColors
    duration={3500}
    visibleToasts={8}
    toastOptions={{
        classes: {
            toast: 'risu-toast',
            title: 'risu-toast-title',
            description: 'risu-toast-description',
        },
    }}
    {...rest}
/>
