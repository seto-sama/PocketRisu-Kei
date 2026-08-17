<script lang="ts">
    import { CreativeCommonsIcon } from "@lucide/svelte";
    import { CCLicenseData } from "src/ts/licenses";
    import { openURL } from "src/ts/globalApi.svelte";
    import ShButton from "../GUI/ShButton.svelte";
    import ShTooltip from "../GUI/ShTooltip.svelte";

    interface Props {
        license?: string;
    }

    let { license = "" }: Props = $props();
</script>

{#if Object.keys(CCLicenseData).includes(license)}
    <ShTooltip>
        {#snippet trigger(props)}
            <ShButton
                {...props}
                variant="link"
                size="sm"
                className="px-0"
                onclick={() => {
                    openURL(`https://creativecommons.org/licenses/${CCLicenseData[license][0]}/4.0/`)
                }}
            >
                <CreativeCommonsIcon />
                Licensed with {CCLicenseData[license][2]}
            </ShButton>
        {/snippet}
        {CCLicenseData[license][1]}. The license only applies to the text.
    </ShTooltip>
{/if}
