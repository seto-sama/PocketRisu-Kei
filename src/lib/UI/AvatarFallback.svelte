<script lang="ts">
    import { UserRoundIcon } from '@lucide/svelte';

    interface Props {
        className?: string;
        style?: string;
        iconClass?: string;
        iconSize?: number;
        strokeWidth?: number;
    }

    let {
        className = '',
        style = '',
        iconClass = '',
        iconSize = 24,
        strokeWidth = 2,
    }: Props = $props();
</script>

<div class="flex items-center justify-center bg-button text-themewhite {className}" {style}>
    <UserRoundIcon class={iconClass} size={iconSize} {strokeWidth} aria-hidden="true" />
</div>
