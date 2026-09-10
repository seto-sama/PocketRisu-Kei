<script lang="ts">
    import { language } from "src/lang";
    import Input from "../../../UI/components/Input.svelte";
    import type { loreBook } from "src/ts/storage/database.svelte";
    import LoreBookList from "src/lib/SideBars/LoreBook/LoreBookList.svelte";
    import { type CCLorebook, convertExternalLorebook } from "src/ts/process/lorebook.svelte";
    import type { RisuModule } from "src/ts/process/modules";
    import { DownloadIcon, FolderPlusIcon, UploadIcon, PlusIcon } from "@lucide/svelte";
    import RegexList from "src/lib/SideBars/Scripts/RegexList.svelte";
    import TriggerList from "src/lib/SideBars/Scripts/TriggerList.svelte";
    import Switch from "../../../UI/components/Switch.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import Textarea from "../../../UI/components/Textarea.svelte";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { alertError, notifySuccess } from "src/ts/alert";
    import { exportRegex, importRegex } from "src/ts/process/scripts";
    import { selectMultipleFile } from "src/ts/util";
    import IconButton from "../../../UI/components/IconButton.svelte";
    import ListActionBar from "../../../UI/components/ListActionBar.svelte";
    import AdditionalAssetsEditor from "src/lib/UI/AdditionalAssetsEditor.svelte";
    import ChoiceGroup from "../../../UI/components/ChoiceGroup.svelte";
    import { v4 } from "uuid";

    let submenu = $state('basic')
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

    function prepareSubmenu(value: string) {
        if (value === 'lorebook') currentModule.lorebook ??= [];
        if (value === 'regex') currentModule.regex ??= [];
        if (value === 'trigger') {
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
            }];
        }
        if (value === 'assets') currentModule.assets ??= [];
    }
</script>

<ChoiceGroup
    variant="pill"
    size="md"
    name="moduleSubmenu"
    bind:value={submenu}
    options={[
        { value: 'basic', label: language.basicInfo },
        { value: 'lorebook', label: language.loreBook },
        { value: 'regex', label: language.moduleRegexLabel },
        { value: 'trigger', label: language.moduleTriggerLuaLabel },
        { value: 'assets', label: language.additionalAssets },
    ]}
    activeColor="selected"
    fullWidth
    divided
    onValueChange={prepareSubmenu}
    className="mb-4"
/>

{#if submenu === 'basic'}
    <span>{language.name}<Help key="moduleName" /></span>
    <Input commitMode="blur" bind:value={currentModule.name} className="mt-2"/>
    <span class="mt-4">{language.description}<Help key="moduleDescription" /></span>
    <Input commitMode="blur" bind:value={currentModule.description} className="mt-2"/>
    <span class="mt-4">{language.namespace}<Help key="namespace" /></span>
    <Input commitMode="blur" bind:value={currentModule.namespace} className="mt-2"/>
    <span class="mt-4">{language.customPromptTemplateToggle}<Help key='customPromptTemplateToggle' /></span>
    <Textarea commitMode="debounce" className="mt-2 mb-4" bind:value={currentModule.customModuleToggle}/>
    <div class="mt-2 flex min-h-10 w-full items-center justify-between gap-2 px-1">
        <span class="min-w-0 text-maintext">{language.hideChatIcon}<Help key="moduleHideChatIcon" /></span>
        <Switch bind:checked={currentModule.hideIcon}/>
    </div>
{/if}
{#if submenu === 'lorebook' && (Array.isArray(currentModule.lorebook))}
    <LoreBookList externalLoreBooks={currentModule.lorebook} moduleMode />
    <ListActionBar mode="footer">
        <IconButton onclick={() => {addLorebook()}}>
            <PlusIcon />
        </IconButton>
        <IconButton onclick={() => {exportLoreBook()}}>
            <DownloadIcon />
        </IconButton>
        <IconButton onclick={() => {importLoreBook()}}>
            <UploadIcon />
        </IconButton>
        <IconButton className="ml-auto" onclick={() => {
            addLorebookFolder()
        }}>
            <FolderPlusIcon />
        </IconButton>
    </ListActionBar>
{/if}

{#if submenu === 'regex' && (Array.isArray(currentModule.regex))}
    <span class="mt-2 flex items-center">{language.backgroundHTML}<Help key="moduleBackgroundEmbedding" /></span>
    <Textarea commitMode="debounce" bind:value={currentModule.backgroundEmbedding} className="mt-2" placeholder={language.backgroundHTML}/>
    <span class="mt-4 flex items-center">{language.moduleRegexLabel}<Help key="moduleRegexList" /></span>
    <RegexList bind:value={currentModule.regex} actionIconSize="default"/>
    <ListActionBar mode="footer">
        <IconButton onclick={() => {
            addRegex()
        }}><PlusIcon /></IconButton>
        <IconButton onclick={() => {
            exportRegex(currentModule.regex)
        }}><DownloadIcon /></IconButton>
        <IconButton onclick={async () => {
            currentModule.regex = await importRegex(currentModule.regex)
        }}><UploadIcon /></IconButton>
    </ListActionBar>
{/if}

{#if submenu === 'assets' && (Array.isArray(currentModule.assets))}
    <span class="mb-2 flex items-center">{language.additionalAssets}<Help key="moduleAdditionalAssets" /></span>
    <AdditionalAssetsEditor
        assets={currentModule.assets}
        onChange={(assets) => {
            currentModule.assets = assets
        }}
    />
{/if}

{#if submenu === 'trigger' && (Array.isArray(currentModule.trigger))}
    <div class="mt-2 flex min-h-10 w-full items-center justify-between gap-2 px-1">
        <span class="min-w-0 text-maintext">{language.lowLevelAccess}<Help key="lowLevelAccess" name={language.lowLevelAccess}/></span>
        <Switch bind:checked={currentModule.lowLevelAccess}/>
    </div>

    <TriggerList bind:value={currentModule.trigger} lowLevelAble={currentModule.lowLevelAccess} />
{/if}
