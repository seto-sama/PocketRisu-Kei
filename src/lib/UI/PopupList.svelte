<script lang="ts">
    import { closePopup, popupStore } from "src/ts/stores.svelte";
    import { sleep } from "src/ts/util";
    import { onDestroy, onMount } from "svelte";
    import Portal from "./GUI/Portal.svelte";

    let styleString = $derived.by(() => {
        let styleString = '';
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        const mouseX = popupStore.mouseX;
        const mouseY = popupStore.mouseY;

        if(mouseX < windowWidth / 2) {
            styleString += `left: ${mouseX}px;`;
        } else {
            styleString += `right: ${windowWidth - mouseX}px;`;
        }
        if(mouseY < windowHeight / 2) {
            styleString += `top: ${mouseY}px;`;
        } else {
            styleString += `bottom: ${windowHeight - mouseY}px;`;
        }
        return styleString;
    });

    onMount(async () => {
        await sleep(0)
        document.addEventListener('click', closePopup);
    })

    onDestroy(() => {
        document.removeEventListener('click', closePopup);
    })

</script>

{#if popupStore.children}
    <Portal>
    <div class="risu-layer-system-popover bg-darkbg border-darkborderc border rounded-md p-4 gap-2 flex flex-col fixed items-start" style={styleString}>
        {@render popupStore.children()}
    </div>
    </Portal>
{/if}
