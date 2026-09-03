<script lang="ts">
    import { MenuIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import IconButton from "./GUI/IconButton.svelte";
    import ShDropdownMenu from "./GUI/ShDropdownMenu.svelte";
    import ShDropdownMenuContent from "./GUI/ShDropdownMenuContent.svelte";
    import ShDropdownMenuTrigger from "./GUI/ShDropdownMenuTrigger.svelte";

    const {
        children
    }:{
        children: import("svelte").Snippet
    } = $props();
    
</script>

<ShDropdownMenu>
    <ShDropdownMenuTrigger>
        {#snippet child({ props })}
            <IconButton {...props} size="lg" className="button-icon-menu" aria-label={language.menu}>
                <MenuIcon />
            </IconButton>
        {/snippet}
    </ShDropdownMenuTrigger>
    <ShDropdownMenuContent side="top" align="end" class="min-w-48">
        {@render children()}
    </ShDropdownMenuContent>
</ShDropdownMenu>
