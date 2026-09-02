<script lang="ts">
    import { CreativeCommonsIcon } from "@lucide/svelte";
    import { CCLicenseData } from "src/ts/licenses";
    import { openURL } from "src/ts/globalApi.svelte";
    import Button from "../components/Button.svelte";
    import Tooltip from "../components/Tooltip.svelte";

    interface Props {
        license?: string;
    }

    let { license = "" }: Props = $props();
</script>

{#if Object.keys(CCLicenseData).includes(license)}
    <Tooltip>
        {#snippet trigger(props)}
            <Button
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
            </Button>
        {/snippet}
        {CCLicenseData[license][1]}. The license only applies to the text.
    </Tooltip>
{/if}
