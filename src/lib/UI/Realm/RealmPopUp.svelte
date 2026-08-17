<script lang="ts">
    import { BookIcon, FlagIcon, ImageIcon, PaperclipIcon, SmileIcon, TrashIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { alertConfirm, alertInput, alertNormal, notifyInfo } from "src/ts/alert";
    import { hubURL, type hubType, downloadRisuHub, getRealmInfo } from "src/ts/characterCards";
    
    import { DBState } from 'src/ts/stores.svelte';
    import RealmLicense from "./RealmLicense.svelte";
    import MultiLangDisplay from "../GUI/MultiLangDisplay.svelte";
    import { tooltip } from "src/ts/gui/tooltip";
    import ShDialog from "../GUI/ShDialog.svelte";
    import ShButton from "../GUI/ShButton.svelte";
    import IconButton from "../GUI/IconButton.svelte";
    import IconButtonGroup from "../GUI/IconButtonGroup.svelte";
    import RealmTagList from "./RealmTagList.svelte";

    interface Props {
        openedData: hubType;
    }

    let { openedData = $bindable() }: Props = $props();
    let open = $state(true)

    function close() {
        open = false
        openedData = null
    }
</script>

<ShDialog
    bind:open
    size="lg"
    closeOnEscape
    onRequestClose={close}
    contentClass="overflow-hidden"
    bodyClass="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden"
>
    {#snippet title()}
        <span class="flex min-w-0 flex-col gap-0.5">
            <span class="block truncate text-2xl">{openedData.name}</span>
            {#if openedData.authorname}
                <span class="truncate text-sm font-normal text-textcolor2">Made by {openedData.authorname}</span>
            {/if}
        </span>
    {/snippet}

    <div class="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
        {#if openedData.original}
            <ShButton variant="link" size="sm" className="w-fit px-0" onclick={() => {
                const original = openedData.original
                close()
                getRealmInfo(original)
            }}>Forked</ShButton>
        {/if}
        <div class="mt-4 flex min-h-36 flex-1 items-start justify-start gap-4 overflow-hidden max-sm:flex-col">
            {#if DBState.db.hideAllImages}
                <div class="flex h-36 w-36 shrink-0 items-center justify-center rounded-md bg-darkbutton text-textcolor2">
                    <span class="text-4xl">?</span>
                </div>
            {:else}
                <img class="h-36 w-36 shrink-0 rounded-md object-cover object-top" alt={openedData.name} src={`${hubURL}/resource/` + openedData.img}>
            {/if}
            <MultiLangDisplay
                value={openedData.desc}
                markdown={true}
                className="min-h-36 max-h-[50vh] min-w-0 flex-1 self-stretch overflow-hidden"
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
                <span class="whitespace-nowrap text-textcolor2" use:tooltip={language.popularityLevelDesc}>
                    {language.popularityLevel.replace('{}', openedData.download.toString())}
                </span>
            </div>
        </div>
    </div>

    <div class="flex shrink-0 gap-2">
        <ShButton variant="primary" className="grow" onclick={() => {
            downloadRisuHub(openedData.id)
            close()
        }}>
            Download
        </ShButton>
        <IconButtonGroup size="xl">
            <IconButton aria-label="Copy Realm link" onclick={(async () => {
                    await navigator.clipboard.writeText(`https://realm.risuai.net/character/${openedData.id}`)
                    notifyInfo(language.clipboardSuccess)
            })}>
                <PaperclipIcon />
            </IconButton>
            {#if (DBState.db.account?.token?.split('-') ?? [])[1] === openedData.creator}
                <IconButton tone="destructive" aria-label="Remove character" onclick={(async () => {
                        const conf = await alertConfirm('Do you want to remove this character from Realm?')
                        if(conf){
                            const da = await fetch(hubURL + '/hub/remove', {
                                method: "POST",
                                body: JSON.stringify({
                                    id: openedData.id,
                                    token: DBState.db.account?.token
                                })
                            })
                            alertNormal(await da.text())
                        }
                })}>
                    <TrashIcon />
                </IconButton>
            {/if}
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
</ShDialog>
