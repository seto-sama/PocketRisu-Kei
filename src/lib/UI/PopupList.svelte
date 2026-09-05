<script lang="ts">
    import { closePopup, popupStore } from "src/ts/stores.svelte";
    import { sleep } from "src/ts/util";
    import { onMount } from "svelte";
    import OverlayPortal from "./components/overlay/OverlayPortal.svelte";
    import { getVisualViewportBounds } from "src/ts/gui/visualViewport";

    let viewport = $state(getVisualViewportBounds());

    let styleString = $derived.by(() => {
        let styleString = '';
        const mouseX = Math.min(Math.max(popupStore.mouseX, viewport.left + 8), viewport.right - 8);
        const mouseY = Math.min(Math.max(popupStore.mouseY, viewport.top + 8), viewport.bottom - 8);

        if(mouseX < viewport.left + viewport.width / 2) {
            styleString += `left: ${mouseX}px;`;
            styleString += `max-width: ${Math.max(0, viewport.right - mouseX - 8)}px;`;
        } else {
            styleString += `right: ${viewport.layoutWidth - mouseX}px;`;
            styleString += `max-width: ${Math.max(0, mouseX - viewport.left - 8)}px;`;
        }
        if(mouseY < viewport.top + viewport.height / 2) {
            styleString += `top: ${mouseY}px;`;
            styleString += `max-height: ${Math.max(0, viewport.bottom - mouseY - 8)}px;`;
        } else {
            styleString += `bottom: ${viewport.layoutHeight - mouseY}px;`;
            styleString += `max-height: ${Math.max(0, mouseY - viewport.top - 8)}px;`;
        }
        return styleString;
    });

    function updateViewport() {
        viewport = getVisualViewportBounds();
    }

    onMount(() => {
        const visualViewport = window.visualViewport;
        let active = true;
        window.addEventListener('resize', updateViewport);
        visualViewport?.addEventListener('resize', updateViewport);
        visualViewport?.addEventListener('scroll', updateViewport);
        void sleep(0).then(() => {
            if (active) document.addEventListener('click', closePopup);
        });

        return () => {
            active = false;
            document.removeEventListener('click', closePopup);
            window.removeEventListener('resize', updateViewport);
            visualViewport?.removeEventListener('resize', updateViewport);
            visualViewport?.removeEventListener('scroll', updateViewport);
        };
    })

</script>

{#if popupStore.children}
    <OverlayPortal>
    <div class="risu-layer-overlay fixed flex flex-col items-start gap-2 overflow-y-auto rounded-md border border-darkborderc bg-darkbg p-4" style={styleString}>
        {@render popupStore.children()}
    </div>
    </OverlayPortal>
{/if}
