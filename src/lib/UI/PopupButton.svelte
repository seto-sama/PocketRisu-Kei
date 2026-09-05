<script lang="ts">
    import { MenuIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import IconButton from "./components/IconButton.svelte";
    import * as DropdownMenu from "./components/dropdown-menu";

    const {
        children
    }:{
        children: import("svelte").Snippet
    } = $props();
    
</script>

<DropdownMenu.Root>
    <DropdownMenu.Trigger>
        {#snippet child({ props })}
            <IconButton {...props} size="lg" className="button-icon-menu" aria-label={language.menu}>
                <MenuIcon />
            </IconButton>
        {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="top" align="end" class="min-w-48">
        {@render children()}
    </DropdownMenu.Content>
</DropdownMenu.Root>
