<script lang="ts">
    import { MenuIcon } from "@lucide/svelte";
    import { closePopup, popupStore } from "src/ts/stores.svelte";
    import { sleep } from "src/ts/util";
    import IconButton from "./GUI/IconButton.svelte";

    const {
        children
    }:{
        children: import("svelte").Snippet
    } = $props();
    
    let buttonId = Math.random()
</script>

<IconButton size="lg" onclick={async (e:MouseEvent) => {
    await sleep(0)
    if(popupStore.openId === buttonId){
        closePopup()
        return
    }
    popupStore.mouseX = e.clientX
    popupStore.mouseY = e.clientY
    popupStore.children = children
    popupStore.openId = buttonId
}} className="button-icon-menu">
    <MenuIcon />
</IconButton>
