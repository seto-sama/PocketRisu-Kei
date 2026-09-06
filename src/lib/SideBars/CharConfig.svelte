<script lang="ts">
    import EmptyState from "src/lib/UI/components/EmptyState.svelte";
    import { language } from "../../lang";
    import { saveImage as saveAsset, type character, getCurrentCharacter } from "../../ts/storage/database.svelte";
    import { convertCharacterToModule } from "src/ts/interchangeability";
    import { alertConfirm, notifySuccess } from "src/ts/alert";
    import { requestImmediateSave } from "src/ts/globalApi.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { CharConfigSubMenu, selectedCharID } from "../../ts/stores.svelte";
    import { PlusIcon, TrashIcon, DownloadIcon, UploadIcon, ArrowUpIcon, ArrowDownIcon, TriangleAlertIcon } from '@lucide/svelte'
    import { getCharImage, selectCharImg, removeChar, changeCharImage } from "../../ts/characters";
    import LoreBook from "./LoreBook/LoreBookSetting.svelte";
    import { getAuthorNoteDefaultText, selectSingleFile } from "../../ts/util";
    import Help from "../Others/Help.svelte";
    import { exportChar } from "src/ts/characterCards";
    import { getElevenTTSVoices, getWebSpeechTTSVoices, getVOICEVOXVoices, oaiVoices, getNovelAIVoices, getTTSApiKey } from "src/ts/process/tts";
    import Input from "../UI/components/Input.svelte";
    import NumberInput from "../UI/components/NumberInput.svelte";
    import Textarea from "../UI/components/Textarea.svelte";
    import Button from "../UI/components/Button.svelte";
    import Select from "../UI/components/Select.svelte";
    import SelectOption from "../UI/components/SelectOption.svelte";
    import RegexList from "./Scripts/RegexList.svelte";
    import TriggerList from "./Scripts/TriggerList.svelte";
    import Checkbox from "../UI/components/Checkbox.svelte";
    import { updateInlayScreen } from "src/ts/process/inlayScreen";
    import { registerOnnxModel } from "src/ts/process/transformers";
    import MultiLangInput from "../UI/components/MultiLangInput.svelte";
    import { exportCharacterPackage, importPackageToCharacter } from "src/ts/characterPackage";
    import { exportRegex, importRegex } from "src/ts/process/scripts";
    import Accordion from "../UI/components/Accordion.svelte";
    import SettingsList from "../UI/components/SettingsList.svelte";
    import Switch from "../UI/components/Switch.svelte";
    import Slider from "../UI/components/Slider.svelte";
    import SettingLayout from "../Setting/Wrappers/SettingLayout.svelte";
    import IconButton from "../UI/components/IconButton.svelte";
    import IconButtonGroup from "../UI/components/IconButtonGroup.svelte";
    import AdditionalAssetsEditor from "../UI/AdditionalAssetsEditor.svelte";
    import TokenCount from "../UI/components/TokenCount.svelte";
    import ChoiceGroup from "../UI/components/ChoiceGroup.svelte";
    import AvatarFallback from "../UI/AvatarFallback.svelte";

    let pkgIncludeCharacter = $state(true)
    let pkgIncludeChats = $state(true)
    let pkgIncludePersona = $state(true)
    let pkgIncludeInlays = $state(false)
    let addingCreatorNotesLang = $state(false)
    let viewSubMenu = $state('icon')
    const gptSoVitsLanguageOptions = [
        ['auto', 'Multi-language Mixed'],
        ['auto_yue', 'Multi-language Mixed (Cantonese)'],
        ['en', 'English'],
        ['zh', 'Chinese-English Mixed'],
        ['ja', 'Japanese-English Mixed'],
        ['yue', 'Cantonese-English Mixed'],
        ['ko', 'Korean-English Mixed'],
        ['all_zh', 'Chinese'],
        ['all_ja', 'Japanese'],
        ['all_yue', 'Cantonese'],
        ['all_ko', 'Korean'],
    ] as const
    const gptSoVitsTextSplitOptions = [
        ['cut0', 'Cut 0 (No splitting)'],
        ['cut1', 'Cut 1 (Split every 4 sentences)'],
        ['cut2', 'Cut 2 (Split every 50 characters)'],
        ['cut3', 'Cut 3 (Split by Chinese periods)'],
        ['cut4', 'Cut 4 (Split by English periods)'],
        ['cut5', 'Cut 5 (Split by various punctuation marks)'],
    ] as const

    function parseVoicevoxStyles(value?: string) {
        if (!value) return [] as { name: string; id: string }[]
        try {
            const styles = JSON.parse(value)
            if (!Array.isArray(styles)) return []
            return styles.filter((style): style is { name: string; id: string } => (
                typeof style?.name === 'string' && typeof style?.id === 'string'
            ))
        } catch {
            return []
        }
    }

    let voicevoxUrl = $derived(DBState.db.voicevoxUrl.trim())
    let voicevoxStyles = $derived(parseVoicevoxStyles(
        DBState.db.characters[$selectedCharID].voicevoxConfig.speaker
    ))

    let licensed = $state((DBState.db.characters[$selectedCharID].type === 'character') ? (DBState.db.characters[$selectedCharID] as character).license : '')


    $effect.pre(() => {
        licensed = (DBState.db.characters[$selectedCharID].type === 'character') ? (DBState.db.characters[$selectedCharID] as character).license : ''
    });

    let emotionAssets = $derived(
        ((DBState.db.characters[$selectedCharID] as character)?.emotionImages ?? [])
            .map(([name, path]) => [name, path, 'png'] as [string, string, string])
    )

    function setEmotionImagesEnabled(enabled: boolean) {
        const char = DBState.db.characters[$selectedCharID] as character
        char.viewScreen = enabled ? 'emotion' : 'none'
        if(!enabled) char.inlayViewScreen = false
        DBState.db.characters[$selectedCharID] = updateInlayScreen(char)
    }

    function setEmotionInlayEnabled(enabled: boolean) {
        const char = DBState.db.characters[$selectedCharID] as character
        char.inlayViewScreen = enabled
        DBState.db.characters[$selectedCharID] = updateInlayScreen(char)
    }

    function setEmotionAssets(assets: [string, string, string][]) {
        const char = DBState.db.characters[$selectedCharID] as character
        char.emotionImages = assets.map(([name, path]) => [name, path])
    }

    $effect.pre(() => {
        if (DBState.db.characters[$selectedCharID].ttsMode === 'novelai' && (DBState.db.characters[$selectedCharID] as character).naittsConfig === undefined) {
            (DBState.db.characters[$selectedCharID] as character).naittsConfig = {
                customvoice: false,
                voice: 'Aini',
                version: 'v2'
            };
        }
    });
    $effect.pre(() => {
        if (DBState.db.characters[$selectedCharID].ttsMode === 'gptsovits' && (DBState.db.characters[$selectedCharID] as character).gptSoVitsConfig === undefined) {
            (DBState.db.characters[$selectedCharID] as character).gptSoVitsConfig = {
                url: '',
                use_auto_path: false,
                ref_audio_path: '',
                use_long_audio: false,
                ref_audio_data: {
                    fileName: '',
                    assetId: ''  
                },
                volume: 1.0,
                text_lang: 'auto',
                text: 'en',
                use_prompt: false,
                prompt_lang: 'en',
                top_p: 1,
                temperature: 0.7,
                speed: 1,
                top_k: 5,
                text_split_method: 'cut0',
            };
        }
    });

    let fishSpeechModels:{
        _id:string,
        title:string,
        description:string
    }[] = $state([])

    $effect.pre(() => {
        if (DBState.db.characters[$selectedCharID].ttsMode === 'openai' && (DBState.db.characters[$selectedCharID] as character).oaiTTSConfig === undefined) {
            (DBState.db.characters[$selectedCharID] as character).oaiTTSConfig = {
                enabled: false,
                format: 'mp3',
            };
        }
    });

    $effect.pre(() => {
        if (DBState.db.characters[$selectedCharID].ttsMode === 'fishspeech' && (DBState.db.characters[$selectedCharID] as character).fishSpeechConfig === undefined) {
            (DBState.db.characters[$selectedCharID] as character).fishSpeechConfig = {
                model: {
                    _id: '',
                    title: '',
                    description: ''
                },
                chunk_length: 200,
                normalize: false,
            };
        }
    });


    async function getFishSpeechModels() {
        try {
            const res = await fetch(`https://api.fish.audio/model?self=true`, {
                headers: {
                    'Authorization': `Bearer ${getTTSApiKey('fishspeech', DBState.db.fishSpeechKey)}`
                }
            });
            const data = await res.json();
            console.log(data.items);
            console.log(DBState.db.characters[$selectedCharID])
            
            if (Array.isArray(data.items)) {
                fishSpeechModels = data.items.map((item) => ({
                    _id: item._id || '',
                    title: item.title || '',
                    description: item.description || ''
                }));
            } else {
                console.error('Expected an array of items, but received:', data.items);
                fishSpeechModels = [];
            }
        } catch (error) {
            console.error('Error fetching fish speech models:', error);
            fishSpeechModels = [];
        }
    }

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
        bind:value={DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].note}
        placeholder={getAuthorNoteDefaultText()}
    />
    <TokenCount value={DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].note} className="mb-4" />
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
                                DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].fmIndex = -1
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
            { value: 'emotion', label: language.emotionImage },
            { value: 'assets', label: language.additionalAssets },
        ]}
        activeColor="selected"
        fullWidth
        divided
        className="mb-4"
    />

    {#if viewSubMenu === 'icon'}
            <div class="mt-2 p-2 border-darkborderc border rounded-md grid grid-cols-3 gap-2">
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


    {:else if viewSubMenu === 'emotion'}
        <SettingsList spacing="none" className="mb-3">
            <SettingsList variant="row">
                <span class="min-w-0 text-maintext">{language.enableEmotionImages}</span>
                <Switch
                    checked={DBState.db.characters[$selectedCharID].viewScreen === 'emotion'}
                    onCheckedChange={setEmotionImagesEnabled}
                />
            </SettingsList>
            {#if DBState.db.characters[$selectedCharID].viewScreen === 'emotion'}
                <SettingsList variant="row">
                    <span class="min-w-0 text-maintext">{language.inlayViewScreen}</span>
                    <Switch
                        checked={(DBState.db.characters[$selectedCharID] as character).inlayViewScreen}
                        onCheckedChange={setEmotionInlayEnabled}
                    />
                </SettingsList>
            {/if}
        </SettingsList>

        {#if DBState.db.characters[$selectedCharID].viewScreen === 'emotion'}
            <AdditionalAssetsEditor
                assets={emotionAssets}
                onChange={setEmotionAssets}
                acceptedExtensions={['png', 'webp', 'gif', 'jpeg', 'jpg', 'svg', 'avif']}
                previewAllAsImages
            />

            {#if (DBState.db.characters[$selectedCharID] as character).inlayViewScreen}
                <span class="mt-3 block text-maintext">{language.emotionInstructions}</span>
                <Textarea bind:value={(DBState.db.characters[$selectedCharID] as character).newGenData.emotionInstructions} />
            {/if}
        {/if}
    {:else if viewSubMenu === 'assets'}

            {#if DBState.db.newImageHandlingBeta}
            <Checkbox card bind:check={DBState.db.characters[$selectedCharID].prebuiltAssetCommand} name={language.insertAssetPrompt}/>

            {#if DBState.db.characters[$selectedCharID].prebuiltAssetCommand}

            <span class="text-maintext mt-2">{language.assetStyle}</span>
            <Select className="mb-4 mt-2" bind:value={DBState.db.characters[$selectedCharID].prebuiltAssetStyle}>
                <SelectOption value="">{language.static}</SelectOption>
                <SelectOption value="dynamic">{language.dynamic}</SelectOption>
            </Select>
            {/if}
            {/if}
            <AdditionalAssetsEditor
                assets={(DBState.db.characters[$selectedCharID] as character).additionalAssets ?? []}
                onChange={(assets) => {
                    (DBState.db.characters[$selectedCharID] as character).additionalAssets = assets
                }}
                onDelete={() => {
                    const char = DBState.db.characters[$selectedCharID] as character
                    char.chats[char.chatPage].fmIndex = -1
                }}
                showExclusionToggle={!!DBState.db.characters[$selectedCharID].prebuiltAssetCommand}
                excludedPaths={DBState.db.characters[$selectedCharID].prebuiltAssetExclude ?? []}
                onExcludedPathsChange={(paths) => {
                    DBState.db.characters[$selectedCharID].prebuiltAssetExclude = paths
                }}
            />
    {/if}
    </div>
{:else if $CharConfigSubMenu === 3}
    <LoreBook />
{:else if $CharConfigSubMenu === 4}
    {#if DBState.db.characters[$selectedCharID].type === 'character'}
        <span class="block text-maintext">{language.backgroundHTML}<Help key="backgroundHTML" /></span>
        <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].backgroundHTML}></Textarea>

        <span class="mt-2 text-maintext">{language.regexScript}<Help key="regexScript"/></span>
        <RegexList bind:value={DBState.db.characters[$selectedCharID].customscript} actionIconSize="default" />
        <IconButtonGroup className="my-2">
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
            <IconButton onclick={async () => {
                DBState.db.characters[$selectedCharID].customscript = await importRegex(DBState.db.characters[$selectedCharID].customscript)
            }}><UploadIcon /></IconButton>
        </IconButtonGroup>

        <TriggerList bind:value={(DBState.db.characters[$selectedCharID] as character).triggerscript} lowLevelAble={DBState.db.characters[$selectedCharID].lowLevelAccess}>
            {#snippet header()}
                <span class="text-maintext">{language.triggerScript}<Help key="triggerScript"/></span>
            {/snippet}
        </TriggerList>
    {/if}
{:else if $CharConfigSubMenu === 6}
    {@const licenseRestricted =
        DBState.db.characters[$selectedCharID].license === 'CC BY-NC-SA 4.0'
        || DBState.db.characters[$selectedCharID].license === 'CC BY-SA 4.0'
        || DBState.db.characters[$selectedCharID].license === 'CC BY-ND 4.0'
        || DBState.db.characters[$selectedCharID].license === 'CC BY-NC-ND 4.0'
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
        {@const char = DBState.db.characters[$selectedCharID] as character}
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
            <Button className="mt-2 w-full" onclick={async () => {
                await importPackageToCharacter($selectedCharID)
            }}>{language.characterPackageImportToChar}</Button>
        </div>
    {/if}

{:else if $CharConfigSubMenu === 5 && DBState.db.ttsEnabled}
    {#if DBState.db.characters[$selectedCharID].type === 'character'}
        <span class="text-maintext">{language.provider}</span>
        <Select className="mb-4 mt-2 w-full" bind:value={DBState.db.characters[$selectedCharID].ttsMode} onchange={() => {
            if(DBState.db.characters[$selectedCharID].type === 'character'){
                (DBState.db.characters[$selectedCharID] as character).ttsSpeech = ''
            }
        }}>
            <SelectOption value="">{language.disabled}</SelectOption>
            <SelectOption value="elevenlab">ElevenLabs</SelectOption>
            <SelectOption value="webspeech">Web Speech</SelectOption>
            <SelectOption value="VOICEVOX">VOICEVOX</SelectOption>
            <SelectOption value="openai">OpenAI</SelectOption>
            <SelectOption value="novelai">NovelAI</SelectOption>
            <SelectOption value="huggingface">Huggingface</SelectOption>
            <SelectOption value="vits">VITS</SelectOption>
            <SelectOption value="gptsovits">GPT-SoVITS</SelectOption>
            <SelectOption value="fishspeech">fish-speech</SelectOption>
        </Select>
        

        {#if DBState.db.characters[$selectedCharID].ttsMode === 'webspeech'}
            {#if !speechSynthesis}
                <span class="text-maintext">Web Speech isn't supported in your browser or OS</span>
            {:else}
                <span class="text-maintext">{language.Speech}</span>
                <Select className="mb-4 mt-2" bind:value={(DBState.db.characters[$selectedCharID] as character).ttsSpeech}>
                    <SelectOption value="">Auto</SelectOption>
                    {#each getWebSpeechTTSVoices() as voice}
                        <SelectOption value={voice}>{voice}</SelectOption>
                    {/each}
                </Select>
                {#if (DBState.db.characters[$selectedCharID] as character).ttsSpeech !== ''}
                    <span class="text-danger text-sm">If you do not set it to Auto, it may not work properly when importing from another OS or browser.</span>
                {/if}
            {/if}
        {:else if DBState.db.characters[$selectedCharID].ttsMode === 'elevenlab'}
            <span class="text-sm mb-2 text-subtext">Please set the ElevenLabs API key in "global Settings → Bot Settings → Others → ElevenLabs API key"</span>
            {#await getElevenTTSVoices() then voices}
                <span class="text-maintext">{language.Speech}</span>
                <Select className="mb-4 mt-2" bind:value={(DBState.db.characters[$selectedCharID] as character).ttsSpeech}>
                    <SelectOption value="">Unset</SelectOption>
                        {#each voices as voice}
                            <SelectOption value={voice.voice_id}>{voice.name}</SelectOption>
                        {/each}
                </Select>
            {/await}
         {:else if DBState.db.characters[$selectedCharID].ttsMode === 'VOICEVOX'}
            {#if !voicevoxUrl}
                <p class="rounded-md border border-darkborderc/50 bg-darkbg/30 px-3 py-2 text-sm text-subtext">
                    {language.ttsVoicevoxUrlRequired}
                </p>
            {:else}
                <span class="text-maintext">Speaker</span>
                <Select className="mb-4 mt-2" bind:value={DBState.db.characters[$selectedCharID].voicevoxConfig.speaker}>
                    {#await getVOICEVOXVoices() then voices}
                        {#each voices as voice}
                            <SelectOption value={voice.list}  selected={DBState.db.characters[$selectedCharID].voicevoxConfig.speaker === voice.list}>{voice.name}</SelectOption>
                        {/each}
                    {:catch}
                        <SelectOption value="">{language.ttsVoicevoxLoadError}</SelectOption>
                    {/await}
                </Select>
                {#if voicevoxStyles.length > 0}
                <span class="text-maintext">Style</span>
                <Select className="mb-4 mt-2" bind:value={DBState.db.characters[$selectedCharID].ttsSpeech}>
                {#each voicevoxStyles as styles}
                        <SelectOption value={styles.id} selected={DBState.db.characters[$selectedCharID].ttsSpeech === styles.id}>{styles.name}</SelectOption>
                {/each}
                </Select>
                {/if}
                <span class="text-maintext">Speed scale</span>
                <NumberInput marginBottom bind:value={DBState.db.characters[$selectedCharID].voicevoxConfig.SPEED_SCALE}/>

                <span class="text-maintext">Pitch scale</span>
                <NumberInput marginBottom bind:value={DBState.db.characters[$selectedCharID].voicevoxConfig.PITCH_SCALE}/>

                <span class="text-maintext">Volume scale</span>
                <NumberInput marginBottom bind:value={DBState.db.characters[$selectedCharID].voicevoxConfig.VOLUME_SCALE}/>

                <span class="text-maintext">Intonation scale</span>
                <NumberInput marginBottom bind:value={DBState.db.characters[$selectedCharID].voicevoxConfig.INTONATION_SCALE}/>
            {/if}
        {:else if DBState.db.characters[$selectedCharID].ttsMode === 'novelai'}
            <SettingsList variant="row">
                <span class="min-w-0 text-maintext">Custom Voice Seed</span>
                <Switch bind:checked={DBState.db.characters[$selectedCharID].naittsConfig.customvoice}/>
            </SettingsList>
            {#if !DBState.db.characters[$selectedCharID].naittsConfig.customvoice}
                <span class="text-maintext">Voice</span>
                <Select className="mb-4 mt-2" bind:value={DBState.db.characters[$selectedCharID].naittsConfig.voice}>
                    {#await getNovelAIVoices() then voices}
                        {#each voices as voiceGroup}
                            <optgroup label={voiceGroup.gender} class="bg-darkbg appearance-none">
                                {#each voiceGroup.voices as voice}
                                    <SelectOption value={voice} selected={DBState.db.characters[$selectedCharID].naittsConfig.voice === voice}>{voice}</SelectOption>
                                {/each}
                            </optgroup>
                        {/each}
                    {/await}
                </Select>
            {:else}
                <span class="text-maintext">Voice</span>
                <Input autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].naittsConfig.voice}/>
            {/if}
            <span class="text-maintext">Version</span>
            <Select className="mb-4 mt-2" bind:value={DBState.db.characters[$selectedCharID].naittsConfig.version}>
                <SelectOption value="v1">v1</SelectOption>
                <SelectOption value="v2">v2</SelectOption>
            </Select>
        {:else if DBState.db.characters[$selectedCharID].ttsMode === 'openai'}
            <span class="text-maintext">Voice</span>
            {#if !DBState.db.characters[$selectedCharID].oaiTTSConfig?.enabled}
                <Select className="mb-4 mt-2" bind:value={DBState.db.characters[$selectedCharID].oaiVoice}>
                    <SelectOption value="">Unset</SelectOption>
                    {#each oaiVoices as voice}
                        <SelectOption value={voice}>{voice}</SelectOption>
                    {/each}
                </Select>
            {:else}
                <Input className="mb-4 mt-2" commitMode="blur"
                    bind:value={DBState.db.characters[$selectedCharID].oaiTTSConfig.voice}
                    placeholder={DBState.db.characters[$selectedCharID].oaiVoice || 'alloy'} />
            {/if}

            <SettingsList variant="row">
                <span class="min-w-0 text-maintext">Advanced (OpenAI-compatible endpoint)</span>
                <Switch bind:checked={DBState.db.characters[$selectedCharID].oaiTTSConfig.enabled} />
            </SettingsList>

            {#if DBState.db.characters[$selectedCharID].oaiTTSConfig?.enabled}
                <span class="text-maintext">Base URL</span>
                <Input className="mb-4 mt-2" commitMode="blur"
                    bind:value={DBState.db.characters[$selectedCharID].oaiTTSConfig.baseURL}
                    placeholder="https://api.openai.com/v1" />

                <span class="text-maintext">API Key (overrides global)</span>
                <Input className="mb-4 mt-2" commitMode="blur" hideText={DBState.db.hideApiKey}
                    bind:value={DBState.db.characters[$selectedCharID].oaiTTSConfig.apiKey}
                    placeholder="Leave empty to use global OpenAI API key" />

                <span class="text-maintext">Model</span>
                <Input className="mb-4 mt-2" commitMode="blur"
                    bind:value={DBState.db.characters[$selectedCharID].oaiTTSConfig.model}
                    placeholder="tts-1" />

                <span class="text-maintext">Response Format</span>
                <Select className="mb-4 mt-2"
                    bind:value={DBState.db.characters[$selectedCharID].oaiTTSConfig.format}>
                    <SelectOption value="mp3">mp3</SelectOption>
                    <SelectOption value="opus">opus</SelectOption>
                    <SelectOption value="aac">aac</SelectOption>
                    <SelectOption value="flac">flac</SelectOption>
                    <SelectOption value="wav">wav</SelectOption>
                    <SelectOption value="pcm">pcm</SelectOption>
                </Select>
            {/if}
        {:else if DBState.db.characters[$selectedCharID].ttsMode === 'huggingface'}
            <span class="text-maintext">Model</span>
            <Input className="mb-4 mt-2" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].hfTTS.model} />

            <span class="text-maintext">Language</span>
            <Input className="mb-4 mt-2" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].hfTTS.language} placeholder="en" />
        {:else if DBState.db.characters[$selectedCharID].ttsMode === 'vits'}
            {#if DBState.db.characters[$selectedCharID].vits}
                <span class="text-maintext">{DBState.db.characters[$selectedCharID].vits.name ?? 'Unnamed VitsModel'}</span>
            {:else}
                <span class="text-maintext">No Model</span>
            {/if}
            <Button onclick={async () => {
                const model = await registerOnnxModel()
                if(model && DBState.db.characters[$selectedCharID].type === 'character'){
                    DBState.db.characters[$selectedCharID].vits = model
                }
            }}>{language.selectModel}</Button>
        {:else if DBState.db.characters[$selectedCharID].ttsMode === 'gptsovits'}
            <SettingLayout variant="row" title="Volume">
                {#snippet control()}<div class="w-48"><Slider min={0} max={1} step={0.01} fixed={2} inputWidth="w-16" bind:value={DBState.db.characters[$selectedCharID].gptSoVitsConfig.volume}/></div>{/snippet}
            </SettingLayout>
            <SettingLayout variant="row" title="URL">
                {#snippet control()}<Input className="w-48" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].gptSoVitsConfig.url}/>{/snippet}
            </SettingLayout>
            <SettingLayout variant="row" title="Use Auto Path">
                {#snippet control()}<Switch bind:checked={DBState.db.characters[$selectedCharID].gptSoVitsConfig.use_auto_path}/>{/snippet}
            </SettingLayout>

            {#if !DBState.db.characters[$selectedCharID].gptSoVitsConfig.use_auto_path}
                <SettingLayout
                    variant="row"
                    title="Reference Audio Path"
                    description="e.g. C:/Users/user/Downloads/GPT-SoVITS-v2-240821"
                >
                    {#snippet control()}<Input className="w-48" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].gptSoVitsConfig.ref_audio_path}/>{/snippet}
                </SettingLayout>
            {/if}

            <SettingLayout variant="row" title="Use Long Audio">
                {#snippet control()}<Switch bind:checked={DBState.db.characters[$selectedCharID].gptSoVitsConfig.use_long_audio}/>{/snippet}
            </SettingLayout>
            <SettingLayout variant="row" title="Reference Audio Data" description="3–10s audio file">
                {#snippet control()}
                    <Button
                        variant="outline"
                        className="w-48 min-w-0"
                        onclick={async () => {
                            const audio = await selectSingleFile(['wav', 'ogg', 'aac', 'mp3'])
                            if(!audio){
                                return
                            }
                            const saveId = await saveAsset(audio.data)
                            DBState.db.characters[$selectedCharID].gptSoVitsConfig.ref_audio_data = {
                                fileName: audio.name,
                                assetId: saveId
                            }
                        }}
                    >
                        <span class="truncate">
                            {DBState.db.characters[$selectedCharID].gptSoVitsConfig.ref_audio_data.assetId
                                ? DBState.db.characters[$selectedCharID].gptSoVitsConfig.ref_audio_data.fileName
                                : language.selectFile}
                        </span>
                    </Button>
                {/snippet}
            </SettingLayout>
            <SettingLayout variant="row" title="Text Language">
                {#snippet control()}
                    <Select className="w-48" bind:value={DBState.db.characters[$selectedCharID].gptSoVitsConfig.text_lang}>
                        {#each gptSoVitsLanguageOptions as [value, label]}
                            <SelectOption {value}>{label}</SelectOption>
                        {/each}
                    </Select>
                {/snippet}
            </SettingLayout>

            {#if !DBState.db.characters[$selectedCharID].gptSoVitsConfig.use_long_audio}
                <SettingLayout variant="row" title="Use Reference Audio Script">
                    {#snippet control()}<Switch bind:checked={DBState.db.characters[$selectedCharID].gptSoVitsConfig.use_prompt}/>{/snippet}
                </SettingLayout>
            {/if}

            {#if DBState.db.characters[$selectedCharID].gptSoVitsConfig.use_prompt && !DBState.db.characters[$selectedCharID].gptSoVitsConfig.use_long_audio}
                <SettingLayout variant="row" title="Reference Audio Script" stacked>
                    <Textarea height="20" bind:value={DBState.db.characters[$selectedCharID].gptSoVitsConfig.prompt}/>
                </SettingLayout>
            {/if}

            <SettingLayout variant="row" title="Reference Audio Language">
                {#snippet control()}
                    <Select className="w-48" bind:value={DBState.db.characters[$selectedCharID].gptSoVitsConfig.prompt_lang}>
                        {#each gptSoVitsLanguageOptions as [value, label]}
                            <SelectOption {value}>{label}</SelectOption>
                        {/each}
                    </Select>
                {/snippet}
            </SettingLayout>
            <SettingLayout variant="row" title="Top P">
                {#snippet control()}<div class="w-48"><Slider min={0} max={1} step={0.05} fixed={2} inputWidth="w-16" bind:value={DBState.db.characters[$selectedCharID].gptSoVitsConfig.top_p}/></div>{/snippet}
            </SettingLayout>
            <SettingLayout variant="row" title="Temperature">
                {#snippet control()}<div class="w-48"><Slider min={0} max={1} step={0.05} fixed={2} inputWidth="w-16" bind:value={DBState.db.characters[$selectedCharID].gptSoVitsConfig.temperature}/></div>{/snippet}
            </SettingLayout>
            <SettingLayout variant="row" title="Speed">
                {#snippet control()}<div class="w-48"><Slider min={0.6} max={1.65} step={0.05} fixed={2} inputWidth="w-16" bind:value={DBState.db.characters[$selectedCharID].gptSoVitsConfig.speed}/></div>{/snippet}
            </SettingLayout>
            <SettingLayout variant="row" title="Top K">
                {#snippet control()}<div class="w-48"><Slider min={1} max={100} step={1} inputWidth="w-16" bind:value={DBState.db.characters[$selectedCharID].gptSoVitsConfig.top_k}/></div>{/snippet}
            </SettingLayout>
            <SettingLayout variant="row" title="Text Split Method">
                {#snippet control()}
                    <Select className="w-48" bind:value={DBState.db.characters[$selectedCharID].gptSoVitsConfig.text_split_method}>
                        {#each gptSoVitsTextSplitOptions as [value, label]}
                            <SelectOption {value}>{label}</SelectOption>
                        {/each}
                    </Select>
                {/snippet}
            </SettingLayout>
        {:else if DBState.db.characters[$selectedCharID].ttsMode === 'fishspeech'}
            {#await getFishSpeechModels()}
                <span class="text-maintext">Loading...</span>
            {:then}
                <span class="text-maintext">Model</span>
                <Select className="mb-4 mt-2" bind:value={DBState.db.characters[$selectedCharID].fishSpeechConfig.model._id}>
                    <SelectOption value="">Not selected</SelectOption>
                    {#each fishSpeechModels as model}
                        <SelectOption value={model._id}>
                            <div class="flex items-center">
                                <span>{model.title}</span>
                                <span class="text-sm text-subtext">{model.description}</span>
                            </div>
                        </SelectOption>
                    {/each}
                </Select>
            {:catch}
                <span class="text-maintext">An error occurred while fetching the models.</span>
            {/await}

            <span class="text-maintext">Chunk Length</span>
            <NumberInput className="mb-4 mt-2" bind:value={DBState.db.characters[$selectedCharID].fishSpeechConfig.chunk_length}/>

            <SettingsList variant="row" className="mb-4 mt-2">
                <span class="min-w-0 text-maintext">Normalize</span>
                <Switch bind:checked={DBState.db.characters[$selectedCharID].fishSpeechConfig.normalize}/>
            </SettingsList>
        {/if}
        {#if DBState.db.characters[$selectedCharID].ttsMode}
            <SettingsList variant="row" className="mt-2">
                <span class="min-w-0 text-maintext">{language.ttsReadOnlyQuoted}</span>
                <Switch bind:checked={DBState.db.characters[$selectedCharID].ttsReadOnlyQuoted}/>
            </SettingsList>
        {/if}
    {/if}
{:else if $CharConfigSubMenu === 2}
        <span class="text-maintext">{language.replaceGlobalNote}<Help key="replaceGlobalNote"/></span>
        <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].replaceGlobalNote}></Textarea>

        <span class="text-maintext mt-2">{language.translatorNote}<Help key="translatorNote" /></span>
        <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].translatorNote}></Textarea>

        <span class="text-maintext mt-2">{language.customPromptTemplateToggle}<Help key="customPromptTemplateToggle" /></span>
        <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].customModuleToggle}></Textarea>

        <span class="text-maintext mt-2">{language.defaultVariables}<Help key="defaultVariables" /></span>
        <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].defaultVariables}></Textarea>

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

        <div class="w-full mt-4">
        <Accordion class="mt-2" name={language.legacySettings}>
            <span class="text-maintext">{language.systemPrompt}<Help key="systemPrompt"/></span>
            <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].systemPrompt}></Textarea>

            <span class="text-maintext mt-2">{language.additionalText}<Help key="additionalText" /></span>
            <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].additionalText}></Textarea>

            <span class="text-maintext">{language.personality}<Help key="personality" unrecommended/></span>
            <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].personality}></Textarea>

            <span class="text-maintext">{language.scenario}<Help key="scenario" unrecommended/></span>
            <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].scenario}></Textarea>

            <span class="text-maintext">{language.exampleMessage}<Help key="exampleMessage"/></span>
            <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].exampleMessage}></Textarea>

            <span class="text-maintext">{language.depthPrompt}</span>
            <div class="flex justify-center items-center mb-4">
                <NumberInput bind:value={DBState.db.characters[$selectedCharID].depth_prompt.depth} className="w-12"/>
                <Input autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].depth_prompt.prompt} className="flex-1"/>
            </div>

            <span class="text-maintext mt-2">Bias<Help key="bias"/></span>
            <div class="w-full max-w-full border border-selected rounded-md p-2">
                <table class="w-full max-w-full tabler mt-2">
                    <tbody>
                    <tr>
                        <th class="font-medium w-1/2">Bias</th>
                        <th class="font-medium w-1/3">{language.value}</th>
                        <th>
                            <IconButton onclick={() => {
                                if(DBState.db.characters[$selectedCharID].type === 'character'){
                                    (DBState.db.characters[$selectedCharID] as character).bias.push(['', 0])
                                }
                            }}><PlusIcon /></IconButton>
                        </th>
                    </tr>
                    {#if (DBState.db.characters[$selectedCharID] as character).bias.length === 0}
                        <tr>
                            <td colspan="3">{language.noBias}</td>
                        </tr>
                    {/if}
                    {#each (DBState.db.characters[$selectedCharID] as character).bias as bias, i}
                        <tr class="align-middle text-center">
                            <td class="font-medium truncate w-1/2">
                                <Input fullh fullwidth bind:value={(DBState.db.characters[$selectedCharID] as character).bias[i][0]} placeholder="string" />
                            </td>
                            <td class="font-medium truncate w-1/3">
                                <NumberInput fullh fullwidth bind:value={(DBState.db.characters[$selectedCharID] as character).bias[i][1]} max={100} min={-100} />
                            </td>
                            <td>
                                <IconButton tone="destructive" onclick={() => {
                                    if(DBState.db.characters[$selectedCharID].type === 'character'){
                                        (DBState.db.characters[$selectedCharID] as character).bias.splice(i, 1)
                                    }
                                }}><TrashIcon /></IconButton>
                            </td>
                        </tr>
                    {/each}
                    </tbody>
                </table>
            </div>

            <div class="mt-4">
                <span class="text-maintext">{language.charjs}<Help key="charjs" unrecommended/></span>
                <Textarea margin="both" autocomplete="off" bind:value={DBState.db.characters[$selectedCharID].virtualscript}></Textarea>
            </div>
        </Accordion>
        </div>

{/if}

<style>

    .tabler {
    table-layout: fixed;
    }

    .tabler td {
        overflow: hidden;
        text-overflow: ellipsis;
    }

</style>
