<script lang="ts">
    import { language } from 'src/lang';
    import Alert from '../../../UI/components/Alert.svelte';
    import { TriangleAlertIcon } from '@lucide/svelte';

    interface Props {
        messageKey: string;
    }

    let { messageKey }: Props = $props();
    let message = $derived((language as any)[messageKey] ?? '');
</script>

<Alert variant="warning" className="mt-2 mb-4">
    {#snippet icon()}<TriangleAlertIcon />{/snippet}
    {message}
</Alert>
