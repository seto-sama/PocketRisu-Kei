<script lang="ts">
    import { BookIcon, FlagIcon, ImageIcon, PaperclipIcon, SmileIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { alertConfirm, alertInput, alertNormal, notifyInfo } from "src/ts/alert";
    import { hubURL, realmURL, type hubType, downloadRisuHub, getRealmInfo } from "src/ts/characterCards";
    
    import { DBState } from 'src/ts/stores.svelte';
    import RealmLicense from "./RealmLicense.svelte";
    import MultiLangDisplay from "../components/MultiLangDisplay.svelte";
    import Dialog from "../components/Dialog.svelte";
    import Button from "../components/Button.svelte";
    import IconButton from "../components/IconButton.svelte";
    import IconButtonGroup from "../components/IconButtonGroup.svelte";
    import RealmTagList from "./RealmTagList.svelte";
    import Tooltip from "../components/Tooltip.svelte";

    interface Props {
        openedData: hubType;
        onDownloaded?: () => void;
    }

    let { openedData = $bindable(), onDownloaded = () => {} }: Props = $props();
    let open = $state(true)
    let downloading = $state(false)

    function close() {
        open = false
        openedData = null
    }
</script>

<Dialog
    bind:open
    size="lg"
    onRequestClose={close}
    bodyClass="flex min-h-0 flex-1 flex-col gap-4"
>
    {#snippet title()}
        <span class="flex min-w-0 flex-col gap-0.5">
            <span class="block truncate text-2xl">{openedData.name}</span>
            {#if openedData.authorname}
                <span class="truncate text-sm font-normal text-subtext">Made by {openedData.authorname}</span>
            {/if}
        </span>
    {/snippet}

    <div class="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
        {#if openedData.original}
            <Button variant="link" size="sm" className="w-fit px-0" onclick={() => {
                const original = openedData.original
                close()
                getRealmInfo(original)
            }}>Forked</Button>
        {/if}
        <div class="mt-4 flex min-h-36 flex-1 items-start justify-start gap-4 overflow-hidden max-sm:flex-col">
            {#if DBState.db.hideAllImages}
                <div class="flex h-36 w-36 shrink-0 items-center justify-center rounded-md bg-button text-subtext">
                    <span class="text-4xl">?</span>
                </div>
            {:else}
                <img class="h-36 w-36 shrink-0 rounded-md object-cover object-top" alt={openedData.name} src={`${hubURL}/resource/` + openedData.img}>
            {/if}
            <MultiLangDisplay
                value={openedData.desc}
                markdown={true}
                className="min-h-36 min-w-0 flex-1 self-stretch overflow-hidden"
                contentClass="min-h-0 flex-1 overflow-y-auto pr-2"
            />
        </div>
        <RealmTagList tags={openedData.tags} className="mt-2" />
        <div class="mt-4 flex min-h-8 w-full items-center justify-between gap-2">
            <RealmLicense license={openedData.license}/>
            <div class="ml-auto flex items-center gap-1">
                <IconButtonGroup size="xl">
                    {#if openedData.hasEmotion}
                        <IconButton onclick={() => {
                            notifyInfo("This character includes emotion images")
                        }} aria-label="Emotion images"><SmileIcon /></IconButton>
                    {/if}
                    {#if openedData.hasAsset}
                        <IconButton onclick={() => {
                            notifyInfo("This character includes additional Assets")
                        }} aria-label="Additional assets"><ImageIcon /></IconButton>
                    {/if}
                    {#if openedData.hasLore}
                        <IconButton onclick={() => {
                            notifyInfo("This character includes lorebook")
                        }} aria-label="Lorebook"><BookIcon /></IconButton>
                    {/if}
                </IconButtonGroup>
                <Tooltip>
                    {#snippet trigger(props)}
                        <span {...props} class="whitespace-nowrap text-subtext">
                            {language.popularityLevel.replace('{}', openedData.download.toString())}
                        </span>
                    {/snippet}
                    {language.popularityLevelDesc}
                </Tooltip>
            </div>
        </div>
    </div>

    <div class="flex shrink-0 gap-2">
        <Button disabled={downloading} variant="primary" className="grow" onclick={async () => {
            if (downloading) return
            downloading = true
            try {
                if (await downloadRisuHub(openedData.id)) {
                    close()
                    onDownloaded()
                }
            } finally {
                downloading = false
            }
        }}>
            {downloading ? language.loading : language.download}
        </Button>
        <IconButtonGroup size="xl">
            <IconButton aria-label="Copy Realm link" onclick={(async () => {
                    await navigator.clipboard.writeText(`${realmURL}/character/${openedData.id}`)
                    notifyInfo(language.clipboardSuccess)
            })}>
                <PaperclipIcon />
            </IconButton>
            <IconButton tone="destructive" aria-label="Report character" onclick={(async () => {
                const conf = await alertConfirm('Report this character?')
                if(conf){
                    const report = await alertInput('Write a report text that would be sent to the admin (for copywrite issues, use email)')
                    const da = await fetch(hubURL + '/hub/report', {
                        method: "POST",
                        body: JSON.stringify({
                            id: openedData.id,
                            report: report
                        })
                    })
                    alertNormal(await da.text())
                }
            })}>
                <FlagIcon />
            </IconButton>
        </IconButtonGroup>
    </div>
</Dialog>
