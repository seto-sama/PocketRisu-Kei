<script lang="ts">
    import EmptyState from "src/lib/UI/components/EmptyState.svelte";
    import { getChatPage } from 'src/ts/storage/chatSelection.svelte';

    import { language } from "../../lang";
    import { type character, getCurrentCharacter } from "../../ts/storage/database.svelte";
    import { convertCharacterToModule } from "src/ts/interchangeability";
    import { alertConfirm, notifySuccess } from "src/ts/alert";
    import { requestImmediateSave } from "src/ts/globalApi.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { CharConfigSubMenu, selectedCharID } from "../../ts/stores.svelte";
    import { PlusIcon, TrashIcon, DownloadIcon, UploadIcon, ArrowUpIcon, ArrowDownIcon, TriangleAlertIcon } from '@lucide/svelte'
    import { getCharImage, selectCharImg, removeChar, changeCharImage } from "../../ts/characters";
    import LoreBook from "./LoreBook/LoreBookSetting.svelte";
    import { getAuthorNoteDefaultText } from "../../ts/util";
    import Help from "../Others/Help.svelte";
    import { exportChar } from "src/ts/characterCards";
    import Input from "../UI/components/Input.svelte";
    import Textarea from "../UI/components/Textarea.svelte";
    import Button from "../UI/components/Button.svelte";
    import Select from "../UI/components/Select.svelte";
    import SelectOption from "../UI/components/SelectOption.svelte";
    import RegexList from "./Scripts/RegexList.svelte";
    import TriggerList from "./Scripts/TriggerList.svelte";
    import OnboardingEditor from "./OnboardingEditor.svelte";
    import Checkbox from "../UI/components/Checkbox.svelte";
    import MultiLangInput from "../UI/components/MultiLangInput.svelte";
    import { exportCharacterPackage, importPackageToCharacter } from "src/ts/characterPackage";
    import { exportRegex, importRegex } from "src/ts/process/scripts";
    import Accordion from "../UI/components/Accordion.svelte";
    import SettingsList from "../UI/components/SettingsList.svelte";
    import Switch from "../UI/components/Switch.svelte";
    import IconButton from "../UI/components/IconButton.svelte";
    import IconButtonGroup from "../UI/components/IconButtonGroup.svelte";
    import ActionBar from "../UI/components/ActionBar.svelte";
    import AdditionalAssetsEditor from "../UI/AdditionalAssetsEditor.svelte";
    import { renderPrebuiltAssetCommand } from "src/ts/assetPromptList";
    import TokenCount from "../UI/components/TokenCount.svelte";
    import ChoiceGroup from "../UI/components/ChoiceGroup.svelte";
    import AvatarFallback from "../UI/AvatarFallback.svelte";
    import TTSPresetBinding from "../UI/TTSPresetBinding.svelte";

    let pkgIncludeCharacter = $state(true)
    let pkgIncludeChats = $state(true)
    let pkgIncludePersona = $state(true)
    let pkgIncludeInlays = $state(false)
    let addingCreatorNotesLang = $state(false)
    let viewSubMenu = $state('icon')

    const licensed = $derived((DBState.db.characters[$selectedCharID].type === 'character') ? (DBState.db.characters[$selectedCharID] as character).license : '')

    function moveAlternateGreetingUp(index: number) {
        if(index === 0) return
        if(DBState.db.characters[$selectedCharID].type === 'character'){
            let alternateGreetings = DBState.db.characters[$selectedCharID].alternateGreetings
            let temp = alternateGreetings[index]
            alternateGreetings[index] = alternateGreetings[index - 1]
            alternateGreetings[index - 1] = temp
            DBState.db.characters[$selectedCharID].alternateGreetings = alternateGreetings
        }
    }

    function moveAlternateGreetingDown(index: number) {
        if(index === DBState.db.characters[$selectedCharID].alternateGreetings.length - 1) return
        if(DBState.db.characters[$selectedCharID].type === 'character'){
            let alternateGreetings = DBState.db.characters[$selectedCharID].alternateGreetings
            let temp = alternateGreetings[index]
            alternateGreetings[index] = alternateGreetings[index + 1]
            alternateGreetings[index + 1] = temp
            DBState.db.characters[$selectedCharID].alternateGreetings = alternateGreetings
        }
    }

</script>

{#snippet legacySettingsHelp()}
    <Help key="legacySettings" name={language.legacySettings} />
{/snippet}

{#if $CharConfigSubMenu === 0}
    {#if licensed !== 'private'}
        <span class="text-maintext">{language.characterName}</span>
        <Input className="mt-2 mb-4" autocomplete="off" placeholder={language.characterName} bind:value={DBState.db.characters[$selectedCharID].name} />
        <span class="text-maintext">{language.nickname}<Help key="nickname" /></span>
        <Input className="mt-2 mb-4" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].nickname}/>
        <span class="text-maintext">{language.description}<Help key="charDesc"/></span>
        <Textarea margin="both" autocomplete="off" bind:value={(DBState.db.characters[$selectedCharID] as character).desc}></Textarea>
        <TokenCount value={(DBState.db.characters[$selectedCharID] as character).desc} className="mb-4" />
    {/if}
    <span class="text-maintext">{language.authorNote}<Help key="chatNote"/></span>
    <Textarea
        margin="both"
        autocomplete="off"
        bind:value={DBState.db.characters[$selectedCharID].chats[getChatPage(DBState.db.characters[$selectedCharID])].note}
        placeholder={getAuthorNoteDefaultText()}
    />
    <TokenCount value={DBState.db.characters[$selectedCharID].chats[getChatPage(DBState.db.characters[$selectedCharID])].note} className="mb-4" />
    {#if licensed !== 'private'}
        <span class="text-maintext">{language.firstMessage}<Help key="charFirstMessage"/></span>
        <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].firstMessage}></Textarea>
        <TokenCount value={DBState.db.characters[$selectedCharID].firstMessage} className="mb-4" />

        <div class="flex w-full items-center justify-between text-maintext">
            <span>{language.altGreet}</span>
            <button class="risu-interactive-accent" onclick={() => {
                if(DBState.db.characters[$selectedCharID].type === 'character'){
                    let alternateGreetings = DBState.db.characters[$selectedCharID].alternateGreetings
                    alternateGreetings.push('')
                    DBState.db.characters[$selectedCharID].alternateGreetings = alternateGreetings
                }
            }}>
                <PlusIcon size={18} />
            </button>
        </div>
        {#if DBState.db.characters[$selectedCharID].alternateGreetings.length === 0}
            <EmptyState title={language.noAlternateGreetings} description="" layout="section" density="compact" size="sm" />
        {/if}
        {#each DBState.db.characters[$selectedCharID].alternateGreetings as greeting, i}
            <div class="mt-2">
                <div class="flex items-center gap-1">
                    <div class="min-w-0 flex-1">
                        <Textarea bind:value={DBState.db.characters[$selectedCharID].alternateGreetings[i]} popupTitle={`${language.altGreet} ${i + 1}`} placeholder="..." fullwidth />
                    </div>
                    <div class="flex flex-col items-center text-subtext">
                        <button class="p-1 risu-interactive-accent disabled:opacity-30" onclick={() => moveAlternateGreetingUp(i)} disabled={i === 0}>
                            <ArrowUpIcon size={16} />
                        </button>
                        <button class="p-1 risu-interactive-accent disabled:opacity-30" onclick={() => moveAlternateGreetingDown(i)} disabled={i === DBState.db.characters[$selectedCharID].alternateGreetings.length - 1}>
                            <ArrowDownIcon size={16} />
                        </button>
                        <button class="p-1 risu-interactive-danger" onclick={() => {
                            if(DBState.db.characters[$selectedCharID].type === 'character'){
                                DBState.db.characters[$selectedCharID].chats[getChatPage(DBState.db.characters[$selectedCharID])].fmIndex = -1
                                let alternateGreetings = DBState.db.characters[$selectedCharID].alternateGreetings
                                alternateGreetings.splice(i, 1)
                                DBState.db.characters[$selectedCharID].alternateGreetings = alternateGreetings
                            }
                        }}>
                            <TrashIcon size={16} />
                        </button>
                    </div>
                </div>
                <TokenCount value={DBState.db.characters[$selectedCharID].alternateGreetings[i]} />
            </div>
        {/each}
    {/if}
    <div class="mt-6">
        <Button
            variant="destructive"
            className="w-full"
            onclick={() => removeChar($selectedCharID, DBState.db.characters[$selectedCharID].name)}
        >
            <TrashIcon />
            <span>{language.removeCharacter}</span>
        </Button>
    </div>
{:else if licensed === 'private'}
    <span>You are not allowed</span>
    {(() => {
        $CharConfigSubMenu = 0
    })()}
{:else if $CharConfigSubMenu === 1}
    <div class="w-full shrink-0">
    <ChoiceGroup
        variant="pill"
        size="md"
        name="characterDisplaySubmenu"
        bind:value={viewSubMenu}
        options={[
            { value: 'icon', label: language.charIcon },
            { value: 'assets', label: language.additionalAssets },
            { value: 'settings', label: language.settings },
        ]}
        activeColor="selected"
        fullWidth
        divided
        className="mb-4"
    />

    {#if viewSubMenu === 'icon'}
            <div class="mt-2 grid grid-cols-3 gap-2">
                {#if DBState.db.characters[$selectedCharID].image !== '' && DBState.db.characters[$selectedCharID].image}
                    {#await getCharImage(DBState.db.characters[$selectedCharID].image, 'css')}
                        <div
                            class="relative group w-full rounded-md shadow-lg bg-button border border-lightborderc {(DBState.db.characters[$selectedCharID] as character).largePortrait ? 'aspect-[9/16]' : 'aspect-square'}"
                        ></div>
                    {:then im}
                        <div
                            class="relative group w-full rounded-md shadow-lg bg-button border border-lightborderc {(DBState.db.characters[$selectedCharID] as character).largePortrait ? 'aspect-[9/16]' : 'aspect-square'}"
                            style={im}
                        >
                            {#if !im}
                                <AvatarFallback className="absolute inset-0 rounded-md" iconClass="h-2/5 w-2/5" />
                            {/if}
                            <button
                                class="absolute right-2 bottom-2 z-10 w-6 h-6 rounded bg-danger/30 hover:bg-danger/70 flex items-center justify-center text-themewhite opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-all"
                                onclick={() => {
                                    DBState.db.characters[$selectedCharID].image = ''
                                    if((DBState.db.characters[$selectedCharID] as character).ccAssets && (DBState.db.characters[$selectedCharID] as character).ccAssets.length > 0){
                                        changeCharImage($selectedCharID, 0)
                                    }
                                }}
                                title={language.remove}
                                aria-label={language.remove}
                            >
                                <TrashIcon size={12} />
                            </button>
                        </div>
                    {/await}
                {:else}
                    <AvatarFallback
                        className="w-full rounded-md shadow-lg border border-lightborderc {(DBState.db.characters[$selectedCharID] as character).largePortrait ? 'aspect-[9/16]' : 'aspect-square'}"
                        iconClass="h-2/5 w-2/5"
                    />
                {/if}
                {#if (DBState.db.characters[$selectedCharID] as character).ccAssets}
                    {#each (DBState.db.characters[$selectedCharID] as character).ccAssets as assets, i}
                        {#await getCharImage(assets.uri, 'css')}
                            <div
                                class="w-full rounded-md shadow-lg bg-button {(DBState.db.characters[$selectedCharID] as character).largePortrait ? 'aspect-[9/16]' : 'aspect-square'}"
                            ></div>
                        {:then im}
                            <div
                                class="relative group w-full rounded-md shadow-lg bg-button cursor-pointer {(DBState.db.characters[$selectedCharID] as character).largePortrait ? 'aspect-[9/16]' : 'aspect-square'}"
                                style={im}
                                role="button"
                                tabindex="0"
                                onclick={() => changeCharImage($selectedCharID, i)}
                                onkeydown={(event) => {
                                    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
                                    event.preventDefault()
                                    changeCharImage($selectedCharID, i)
                                }}
                            >
                                {#if !im}
                                    <AvatarFallback className="absolute inset-0 rounded-md" iconClass="h-2/5 w-2/5" />
                                {/if}
                                <button
                                    class="absolute right-2 bottom-2 z-10 w-6 h-6 rounded bg-danger/30 hover:bg-danger/70 flex items-center justify-center text-themewhite opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-all"
                                    onclick={(event) => {
                                        event.stopPropagation()
                                        const char = DBState.db.characters[$selectedCharID] as character
                                        char.ccAssets.splice(i, 1)
                                    }}
                                    title={language.remove}
                                    aria-label={language.remove}
                                >
                                    <TrashIcon size={12} />
                                </button>
                            </div>
                        {/await}
                    {/each}
                {/if}
                <button
                    class="w-full rounded-md cursor-pointer border-darkborderc border border-dashed flex justify-center items-center text-subtext opacity-75 risu-interactive-surface risu-interactive-reveal transition-[background-color,opacity] {(DBState.db.characters[$selectedCharID] as character).largePortrait ? 'aspect-[9/16]' : 'aspect-square'}"
                    onclick={async () => {await selectCharImg($selectedCharID);}}
                    data-file-picker
                >
                    <PlusIcon />
                </button>
            </div>

        {#if DBState.db.characters[$selectedCharID].image !== ''}
            <SettingsList spacing="none" className="mt-4">
                <SettingsList variant="row">
                    <span class="min-w-0 text-maintext">{language.largePortrait}</span>
                    <Switch bind:checked={(DBState.db.characters[$selectedCharID] as character).largePortrait}/>
                </SettingsList>
            </SettingsList>
        {/if}


    {:else if viewSubMenu === 'assets'}
            <AdditionalAssetsEditor
                assets={(DBState.db.characters[$selectedCharID] as character).additionalAssets ?? []}
                onChange={(assets) => {
                    (DBState.db.characters[$selectedCharID] as character).additionalAssets = assets
                }}
                onDelete={() => {
                    const char = DBState.db.characters[$selectedCharID] as character
                    char.chats[getChatPage(char)].fmIndex = -1
                }}
                showExclusionToggle={!!DBState.db.characters[$selectedCharID].prebuiltAssetCommand}
                excludedPaths={DBState.db.characters[$selectedCharID].prebuiltAssetExclude ?? []}
                onExcludedPathsChange={(paths) => {
                    DBState.db.characters[$selectedCharID].prebuiltAssetExclude = paths
                }}
            />
    {:else if viewSubMenu === 'settings'}
        <span class="text-maintext">{language.replaceGlobalNote}<Help key="replaceGlobalNote"/></span>
        <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].replaceGlobalNote}></Textarea>

        {#if DBState.db.characters[$selectedCharID].prebuiltAssetCommand}
            <span class="mt-4 block text-maintext">{language.assetPrompt}<Help key="assetPrompt"/></span>
            <Textarea margin="both" readonly value={renderPrebuiltAssetCommand(DBState.db.characters[$selectedCharID] as character)}></Textarea>
        {/if}

        <SettingsList spacing="none" className="mb-2">
            {#if DBState.db.newImageHandlingBeta}
                <SettingsList variant="row">
                    <span class="min-w-0 text-maintext">
                        {language.insertAssetPrompt}<Help key="insertAssetPrompt" name={language.insertAssetPrompt}/>
                    </span>
                    <Switch bind:checked={DBState.db.characters[$selectedCharID].prebuiltAssetCommand}/>
                </SettingsList>
            {/if}
            <SettingsList variant="row">
                <span class="min-w-0 text-maintext">
                    {language.assetStyle}<Help key="assetStyle" name={language.assetStyle}/>
                </span>
                <Select size="sm" className="w-32" bind:value={DBState.db.characters[$selectedCharID].prebuiltAssetStyle}>
                    <SelectOption value="">{language.static}</SelectOption>
                    <SelectOption value="dynamic">{language.dynamic}</SelectOption>
                </Select>
            </SettingsList>
        </SettingsList>
    {/if}
    </div>
{:else if $CharConfigSubMenu === 3}
    <LoreBook />
{:else if $CharConfigSubMenu === 4}
    {#if DBState.db.characters[$selectedCharID].type === 'character'}
        <span class="block text-maintext">{language.backgroundHTML}<Help key="backgroundHTML" /></span>
        <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].backgroundHTML}></Textarea>

        <div class="mt-2 text-maintext">
            <span>{language.regexScript}<Help key="regexScript"/></span>
            <RegexList bind:value={DBState.db.characters[$selectedCharID].customscript} actionIconSize="default" />
            <ActionBar mode="footer">
                <IconButtonGroup>
                    <IconButton onclick={() => {
                        if(DBState.db.characters[$selectedCharID].type === 'character'){
                            let script = DBState.db.characters[$selectedCharID].customscript
                            script.push({
                            comment: "",
                            in: "",
                            out: "",
                            type: "editinput"
                            })
                            DBState.db.characters[$selectedCharID].customscript = script
                        }
                    }}><PlusIcon /></IconButton>
                    <IconButton onclick={() => {
                        exportRegex(DBState.db.characters[$selectedCharID].customscript)
                    }}><DownloadIcon /></IconButton>
                    <IconButton data-file-picker onclick={async () => {
                        DBState.db.characters[$selectedCharID].customscript = await importRegex(DBState.db.characters[$selectedCharID].customscript)
                    }}><UploadIcon /></IconButton>
                </IconButtonGroup>
            </ActionBar>
        </div>

        <TriggerList bind:value={(DBState.db.characters[$selectedCharID] as character).triggerscript} lowLevelAble={DBState.db.characters[$selectedCharID].lowLevelAccess}>
            {#snippet header()}
                <span class="text-maintext">{language.triggerScript}<Help key="triggerScript"/></span>
            {/snippet}
        </TriggerList>

        <OnboardingEditor character={DBState.db.characters[$selectedCharID] as character} />
    {/if}
{:else if $CharConfigSubMenu === 6}
    {const licenseRestricted =
        $derived(DBState.db.characters[$selectedCharID].license === 'CC BY-NC-SA 4.0'
        || DBState.db.characters[$selectedCharID].license === 'CC BY-SA 4.0'
        || DBState.db.characters[$selectedCharID].license === 'CC BY-ND 4.0'
        || DBState.db.characters[$selectedCharID].license === 'CC BY-NC-ND 4.0')
    }

    <span class="text-maintext">{language.creator}</span>
    <Input className="mt-2 mb-4" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].additionalData.creator} />

    <span class="text-maintext">{language.CharVersion}</span>
    <Input className="mt-2 mb-4" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].additionalData.character_version}/>

    <div class="flex w-full items-center justify-between text-maintext">
        <span>{language.creatorNotes}<Help key="creatorQuotes"/></span>
        <button class="risu-interactive-accent" aria-label={language.add} title={language.add} onclick={() => {
            addingCreatorNotesLang = !addingCreatorNotesLang
        }}>
            <PlusIcon size={18} />
        </button>
    </div>
    <MultiLangInput bind:value={DBState.db.characters[$selectedCharID].creatorNotes} bind:addingLang={addingCreatorNotesLang} className="my-2" onInput={() => {
        DBState.db.characters[$selectedCharID].removedQuotes = false
    }}></MultiLangInput>

    {#if licenseRestricted}
        <div class="mt-6 mb-2 flex items-center gap-2 text-sm text-danger">
            <TriangleAlertIcon size={16} class="shrink-0" />
            <span>{language.characterPackageLicenseWarning} ({DBState.db.characters[$selectedCharID].license})</span>
        </div>
    {/if}

    {#if !licenseRestricted}
        <Button onclick={async () => {
            const res = await exportChar($selectedCharID)
        }} className="mt-6">{language.exportCharacter}</Button>
    {/if}

    <Button className="mt-2" onclick={async () => {
        const char = getCurrentCharacter()
        if (!await alertConfirm(language.convertCharacterToModuleConfirm.replace('{}', char.name))) return
        const m = convertCharacterToModule(char)
        DBState.db.modules.push(m)
        void requestImmediateSave()
        notifySuccess(language.successfullyConverted)
    }}>{language.convertToModule}</Button>

    {#if DBState.db.characters[$selectedCharID].type === 'character'}
        {const char = $derived(DBState.db.characters[$selectedCharID] as character)}
        <div class="mt-6 border-t border-darkborderc pt-4">
            <h3 class="text-lg font-bold mb-3">{language.characterPackage}</h3>
            {#key $selectedCharID}
                <div class="flex items-center justify-between py-1">
                    <Checkbox check={licenseRestricted ? false : pkgIncludeCharacter} name={language.characterPackageCharacter + ' (charx)'} margin={false}
                        onChange={(v) => { pkgIncludeCharacter = v }}
                        className={licenseRestricted ? "opacity-50 pointer-events-none" : ""} />
                    <span class="text-subtext text-sm ml-2 truncate shrink-0">{char.name}</span>
                </div>
                <div class="flex items-center justify-between py-1">
                    <Checkbox bind:check={pkgIncludeChats} name={language.characterPackageChats + ' (json)'} margin={false} />
                    <span class="text-subtext text-sm ml-2 shrink-0">{char.chats.length}{language.characterPackageChatCount}</span>
                </div>
                <div class="flex items-center py-1">
                    <Checkbox bind:check={pkgIncludePersona} name={language.characterPackagePersona} margin={false} />
                </div>
                <div class="flex items-center py-1">
                    <Checkbox bind:check={pkgIncludeInlays} name={language.characterPackageInlays} margin={false} />
                </div>
            {/key}
            <Button className="mt-2 w-full" onclick={async () => {
                await exportCharacterPackage($selectedCharID, {
                    includeCharacter: licenseRestricted ? false : pkgIncludeCharacter,
                    includeChats: pkgIncludeChats,
                    includePersona: pkgIncludePersona,
                    includeInlays: pkgIncludeInlays
                })
            }}>{language.characterPackageExport}</Button>
            <Button className="mt-2 w-full" data-file-picker onclick={async () => {
                await importPackageToCharacter($selectedCharID)
            }}>{language.characterPackageImportToChar}</Button>
        </div>
    {/if}

{:else if $CharConfigSubMenu === 2}
        <span class="text-maintext">{language.translatorNote}<Help key="translatorNote" /></span>
        <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].translatorNote}></Textarea>

        <span class="text-maintext mt-2">{language.customPromptTemplateToggle}<Help key="customPromptTemplateToggle" /></span>
        <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].customModuleToggle}></Textarea>

        <span class="text-maintext mt-2">{language.defaultVariables}<Help key="defaultVariables" /></span>
        <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].defaultVariables}></Textarea>

        {#if DBState.db.characters[$selectedCharID].type === 'character'}
            <div class="mt-4">
                <span class="mb-1 block text-xs text-subtext">{language.ttsPresetBinding}</span>
                <TTSPresetBinding bind:value={(DBState.db.characters[$selectedCharID] as character).ttsPresetId}/>
            </div>
        {/if}

        <SettingsList spacing="none" className="mt-4">
            <SettingsList variant="row">
                <span class="min-w-0 text-maintext">{language.utilityBot}<Help key="utilityBot" name={language.utilityBot}/></span>
                <Switch bind:checked={DBState.db.characters[$selectedCharID].utilityBot}/>
            </SettingsList>
            <SettingsList variant="row">
                <span class="min-w-0 text-maintext">{language.lowLevelAccess}<Help key="lowLevelAccess" name={language.lowLevelAccess}/></span>
                <Switch bind:checked={DBState.db.characters[$selectedCharID].lowLevelAccess}/>
            </SettingsList>
            <SettingsList variant="row">
                <span class="min-w-0 text-maintext">{language.hideChatIcon}</span>
                <Switch bind:checked={DBState.db.characters[$selectedCharID].hideChatIcon}/>
            </SettingsList>
            <SettingsList variant="row">
                <span class="min-w-0 text-maintext">{language.escapeOutput}</span>
                <Switch bind:checked={(DBState.db.characters[$selectedCharID] as character).escapeOutput}/>
            </SettingsList>
        </SettingsList>

        <div class="mt-4 w-full shrink-0">
        <Accordion name={language.legacySettings} extras={legacySettingsHelp}>
            <div class="flex flex-col">
            <span class="mt-2 block text-maintext">{language.systemPrompt}<Help key="systemPrompt"/></span>
            <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].systemPrompt}></Textarea>

            <span class="mt-2 block text-maintext">{language.additionalText}<Help key="additionalText" /></span>
            <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].additionalText}></Textarea>

            <span class="mt-2 block text-maintext">{language.personality}<Help key="personality" unrecommended/></span>
            <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].personality}></Textarea>

            <span class="mt-2 block text-maintext">{language.scenario}<Help key="scenario" unrecommended/></span>
            <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].scenario}></Textarea>

            <span class="mt-2 block text-maintext">{language.exampleMessage}<Help key="exampleMessage"/></span>
            <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].exampleMessage}></Textarea>

            <span class="mt-2 block text-maintext">{language.depthPrompt}</span>
            <Textarea className="mt-2" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].depth_prompt.prompt}/>
            </div>
        </Accordion>
        </div>

{/if}
