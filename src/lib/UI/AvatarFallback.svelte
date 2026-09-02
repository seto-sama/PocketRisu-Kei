<script lang="ts">
    import { UserRoundIcon } from '@lucide/svelte';

    interface Props {
        className?: string;
        style?: string;
        iconClass?: string;
        iconSize?: number;
    }

    let {
        className = '',
        style = '',
        iconClass = '',
        iconSize = 24,
    }: Props = $props();
</script>

<div class="flex items-center justify-center bg-button text-themewhite {className}" {style}>
    <UserRoundIcon class={iconClass} size={iconSize} aria-hidden="true" />
</div>
