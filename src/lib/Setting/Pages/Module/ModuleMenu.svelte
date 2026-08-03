<script lang="ts">
    import { language } from "src/lang";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import type { loreBook } from "src/ts/storage/database.svelte";
    import LoreBookList from "src/lib/SideBars/LoreBook/LoreBookList.svelte";
    import { type CCLorebook, convertExternalLorebook } from "src/ts/process/lorebook.svelte";
    import type { RisuModule } from "src/ts/process/modules";
    import { DownloadIcon, FolderPlusIcon, HardDriveUploadIcon, PencilIcon, PlusIcon } from "@lucide/svelte";
    import RegexList from "src/lib/SideBars/Scripts/RegexList.svelte";
    import TriggerList from "src/lib/SideBars/Scripts/TriggerList.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { alertError, notifySuccess } from "src/ts/alert";
    import { exportRegex, importRegex } from "src/ts/process/scripts";
    import { selectMultipleFile } from "src/ts/util";
    import IconButton from "src/lib/UI/GUI/IconButton.svelte";
    import IconButtonGroup from "src/lib/UI/GUI/IconButtonGroup.svelte";
    import AdditionalAssetsEditor from "src/lib/UI/AdditionalAssetsEditor.svelte";
    import { v4 } from "uuid";

    let submenu = $state(0)
    let loreListEditMode = $state(false)
    interface Props {
        currentModule: RisuModule;
    }

    let { currentModule = $bindable() }: Props = $props();

    function addLorebook(){
        if(Array.isArray(currentModule.lorebook)){
            currentModule.lorebook.push({
                key: '',
                comment: `New Lore`,
                content: '',
                mode: 'normal',
                insertorder: 100,
                alwaysActive: false,
                secondkey: "",
                selective: false
            })

            currentModule.lorebook = currentModule.lorebook
        }
    }

    function addLorebookFolder(){
        if(Array.isArray(currentModule.lorebook)){
            const id = v4()
            currentModule.lorebook.push({
                key: '\uf000folder:' + id,
                comment: `New Folder`,
                content: '',
                mode: 'folder',
                insertorder: 100,
                alwaysActive: false,
                secondkey: "",
                selective: false,
            })

            currentModule.lorebook = currentModule.lorebook
        }
    }

    async function exportLoreBook(){
        try {
            const lore = currentModule.lorebook        
            const stringl = Buffer.from(JSON.stringify({
                type: 'risu',
                ver: 1,
                data: lore
            }), 'utf-8')

            await downloadFile(`lorebook_export.json`, stringl)

            notifySuccess(language.successExport)
        } catch (error) {
            alertError(`${error}`)
        }
    }

    async function importLoreBook(){
        let lore = currentModule.lorebook
        const lorebook = (await selectMultipleFile(['json', 'lorebook']))
        if(!lorebook){
            return
        }
        try {
            for(const f of lorebook){
                const importedlore = JSON.parse(Buffer.from(f.data).toString('utf-8'))
                if(importedlore.type === 'risu' && importedlore.data){
                    const datas:loreBook[] = importedlore.data
                    for(const data of datas){
                        lore.push(data)
                    }
                }
                else if(importedlore.entries){
                    const entries:{[key:string]:CCLorebook} = importedlore.entries
                    lore.push(...convertExternalLorebook(entries))
                }
            }
        } catch (error) {
            alertError(`${error}`)
        }
    }

    function addRegex(){
        if(Array.isArray(currentModule.regex)){
            currentModule.regex.push({
                comment: "",
                in: "",
                out: "",
                type: "editinput"
            })

            currentModule.regex = currentModule.regex
        }
    }

    function addTrigger(){
        if(Array.isArray(currentModule.trigger)){
            currentModule.trigger.push({
                conditions: [],
                type: 'start',
                comment: '',
                effect: []
            })

            currentModule.trigger = currentModule.trigger
        }
    }
</script>

<div class="flex w-full rounded-md border border-darkborderc mb-4 overflow-x-auto h-16 min-h-16 overflow-y-clip">
    <button onclick={() => {
        submenu = 0
    }} class="p-2 flex-1 border-r border-darkborderc" class:bg-darkbutton={submenu === 0}>
        <span>{language.basicInfo}</span>
    </button>
    <button onclick={() => {
        currentModule.lorebook ??= []
        submenu = 1
    }} class="p2 flex-1 border-r border-darkborderc" class:bg-darkbutton={submenu === 1}>
        <span>{language.loreBook}</span>
    </button>
    <button onclick={() => {
        currentModule.regex ??= []
        submenu = 2
    }} class="p-2 flex-1 border-r border-darkborderc" class:bg-darkbutton={submenu === 2}>
        <span>{language.regexScript}</span>
    </button>
    <button onclick={() => {
        currentModule.trigger ??= [{
            comment: "",
            type: "manual",
            conditions: [],
            effect: [{
                type: "v2Header",
                code: "",
                indent: 0
            }]
        }, {
            comment: "New Event",
            type: 'manual',
            conditions: [],
            effect: []
        }]
        submenu = 3
    }} class="p-2 flex-1 border-r border-darkborderc" class:bg-darkbutton={submenu === 3}>
        <span>{language.triggerScript}</span>
    </button>
    <button onclick={() => {
        currentModule.assets ??= []
        submenu = 5
    }} class="p-2 flex-1" class:bg-darkbutton={submenu === 5}>
        <span>{language.additionalAssets}</span>
    </button>
</div>

{#if submenu === 0}
    <span>{language.name}<Help key="moduleName" /></span>
    <TextInput bind:value={currentModule.name} className="mt-2"/>
    <span class="mt-4">{language.description}<Help key="moduleDescription" /></span>
    <TextInput bind:value={currentModule.description} className="mt-2"/>
    <span class="mt-4">{language.namespace}<Help key="namespace" /></span>
    <TextInput bind:value={currentModule.namespace} className="mt-2"/>
    <span class="mt-4">{language.customPromptTemplateToggle}<Help key='customPromptTemplateToggle' /></span>
    <TextAreaInput className="mt-2 mb-4" bind:value={currentModule.customModuleToggle}/>
    <div class="mt-2 flex min-h-10 w-full items-center justify-between gap-2 px-1">
        <span class="min-w-0 text-textcolor">{language.hideChatIcon}<Help key="moduleHideChatIcon" /></span>
        <ShSwitch bind:checked={currentModule.hideIcon}/>
    </div>
{/if}
{#if submenu === 1 && (Array.isArray(currentModule.lorebook))}
    <LoreBookList externalLoreBooks={currentModule.lorebook} moduleMode bind:listEditMode={loreListEditMode} />
    <IconButtonGroup size="default" className="mt-2 w-full">
        <IconButton onclick={() => {addLorebook()}}>
            <PlusIcon />
        </IconButton>
        <IconButton onclick={() => {exportLoreBook()}}>
            <DownloadIcon />
        </IconButton>
        <IconButton onclick={() => {importLoreBook()}}>
            <HardDriveUploadIcon />
        </IconButton>
        <IconButton
            active={loreListEditMode}
            activeColor="primary"
            aria-label={language.changeFolderName}
            onclick={() => {
                loreListEditMode = !loreListEditMode
            }}
        >
            <PencilIcon />
        </IconButton>
        <IconButton className="ml-auto" onclick={() => {
            addLorebookFolder()
        }}>
            <FolderPlusIcon />
        </IconButton>
    </IconButtonGroup>
{/if}

{#if submenu === 2 && (Array.isArray(currentModule.regex))}
    <span class="mt-2 flex items-center">{language.backgroundHTML}<Help key="moduleBackgroundEmbedding" /></span>
    <TextAreaInput bind:value={currentModule.backgroundEmbedding} className="mt-2" placeholder={language.backgroundHTML}/>
    <span class="mt-4 flex items-center">{language.regexScript}<Help key="moduleRegexList" /></span>
    <RegexList bind:value={currentModule.regex} actionIconSize="default"/>
    <IconButtonGroup size="default" className="mt-2">
        <IconButton onclick={() => {
            addRegex()
        }}><PlusIcon /></IconButton>
        <IconButton onclick={() => {
            exportRegex(currentModule.regex)
        }}><DownloadIcon /></IconButton>
        <IconButton onclick={async () => {
            currentModule.regex = await importRegex(currentModule.regex)
        }}><HardDriveUploadIcon /></IconButton>
    </IconButtonGroup>
{/if}

{#if submenu === 5 && (Array.isArray(currentModule.assets))}
    <span class="mb-2 flex items-center">{language.additionalAssets}<Help key="moduleAdditionalAssets" /></span>
    <AdditionalAssetsEditor
        assets={currentModule.assets}
        onChange={(assets) => {
            currentModule.assets = assets
        }}
    />
{/if}

{#if submenu === 3 && (Array.isArray(currentModule.trigger))}
    <div class="mt-2 flex min-h-10 w-full items-center justify-between gap-2 px-1">
        <span class="min-w-0 text-textcolor">{language.lowLevelAccess}<Help key="lowLevelAccess" name={language.lowLevelAccess}/></span>
        <ShSwitch bind:checked={currentModule.lowLevelAccess}/>
    </div>

    <TriggerList bind:value={currentModule.trigger} lowLevelAble={currentModule.lowLevelAccess} />
{/if}
