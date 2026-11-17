<script lang="ts">
    import { ExternalLinkIcon, HeartIcon, TriangleAlertIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { openURL } from "src/ts/globalApi.svelte";
    import Alert from "../UI/components/Alert.svelte";
    import Button from "../UI/components/Button.svelte";
    import Dialog from "../UI/components/Dialog.svelte";

    const POCKETRISU_PATREON_URL = 'https://www.patreon.com/cw/PocketRisu'
    const RISUAI_PATREON_URL = 'https://www.patreon.com/RisuAI'

    let { open = $bindable(false) }: { open?: boolean } = $props();
</script>

<Dialog bind:open size="default" closable ariaLabel={language.support}>
    <!-- One shared column width so buttons, alert and text share the same edges;
         tight gaps inside a group, wider gaps between groups. -->
    <div class="mx-auto flex w-full max-w-sm flex-col gap-6 pt-1 pb-4 text-center break-keep">
        <div class="flex flex-col items-center gap-3">
            <div class="flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary">
                <HeartIcon size={24} />
            </div>
            <h2 class="text-xl font-bold text-maintext">{language.support}</h2>
        </div>
        <div class="flex flex-col gap-2">
            <p class="mb-1 text-sm leading-relaxed text-subtext">{language.supportNotice}</p>
            <Button variant="primary" className="w-full" onclick={() => openURL(RISUAI_PATREON_URL)}>
                {language.supportRisuAI}
                <ExternalLinkIcon size={13} />
            </Button>
            <Button variant="primary" className="w-full" onclick={() => openURL(POCKETRISU_PATREON_URL)}>
                {language.supportPocketRisu}
                <ExternalLinkIcon size={13} />
            </Button>
        </div>
        <Alert variant="warning" className="text-left">
            {#snippet icon()}<TriangleAlertIcon />{/snippet}
            {language.supportPhishingWarn}
        </Alert>
    </div>
</Dialog>
