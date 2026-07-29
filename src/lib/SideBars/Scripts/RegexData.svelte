<script lang="ts">
    import { TrashIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { ReloadGUIPointer } from "src/ts/stores.svelte";
    import { alertConfirm } from "src/ts/alert";
    import type { customscript } from "src/ts/storage/database.svelte";
    import TextInput from "../../UI/GUI/TextInput.svelte";
    import TextAreaInput from "../../UI/GUI/TextAreaInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import ShSwitch from "src/lib/UI/GUI/ShSwitch.svelte";
    import ShDisclosureList from "src/lib/UI/GUI/ShDisclosureList.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import IconButton from "src/lib/UI/GUI/IconButton.svelte";
    import type { IconButtonSize } from "src/lib/UI/GUI/IconButton.svelte";
    import type { ActiveRegexScriptType } from "./regexScriptGroups";
    interface Props {
        value: customscript;
        selectedTypes?: string[];
        onToggleType?: (type: ActiveRegexScriptType | 'disabled') => void;
        onSharedChange?: () => void;
        onRemove?: () => void;
        onClose?: () => void;
        onOpen?: () => void;
        isOpen?: boolean;
        idx: number;
        embedded?: boolean;
        actionIconSize?: IconButtonSize;
    }

    let {
        value = $bindable(),
        selectedTypes = [],
        onToggleType = () => {},
        onSharedChange = () => {},
        onRemove = () => {},
        onClose = () => {},
        onOpen = () => {},
        isOpen = false,
        idx,
        embedded = false,
        actionIconSize = 'default',
    }: Props = $props();

    const ensureFlag = () => {
        value.flag ??= 'g'
    }

    const checkFlagContain = (flag:string, matchFlag:string = value.flag ?? 'g') => {
        if(flag.length === 1){
            matchFlag = matchFlag.replace(/<(.+?)>/g, '')
        }
        return matchFlag.includes(flag)
    }

    const toggleFlag = (flag:string) => {
        ensureFlag()
        if(checkFlagContain(flag, value.flag)){
            value.flag = value.flag.replace(flag, '')
        }
        else{
            value.flag += flag
        }
        onSharedChange()
    }

    const getOrder = (flag:string = value.flag ?? 'g') => {
        const order = flag.match(/<order (-?\d+)>/)?.[1]
        if(order === undefined || order === null){
            return 0
        }
        return parseInt(order)
    }

    const changeOrder = (order:number) => {
        ensureFlag()
        if(value.flag.includes('<order')){
            value.flag = value.flag.replace(/<order (-?\d+)>/, `<order ${order}>`)
        }
        else{
            value.flag += `<order ${order}>`
        }
        onSharedChange()
    }

    const flags = [
        //Vanila JS flags
        ['Global (g)', 'g'],
        ['Case Insensitive (i)', 'i'],
        ['Multi Line (m)', 'm'],
        ['Unicode (u)', 'u'],
        ['Dot All (s)', 's'],

        //Custom flags
        ['Move Top', '<move_top>'],
        ['Move Bottom', '<move_bottom>'],
        ['Repeat Back', '<repeat_back>'],
        ['IN CBS Parsing', '<cbs>'],
        ['No Newline Subfix', '<no_end_nl>'],
    ]

    const scriptTypes = [
        ['editinput', language.editInput],
        ['editoutput', language.editOutput],
        ['editprocess', language.editProcess],
        ['editdisplay', language.editDisplay],
        ['edittrans', language.editTranslationDisplay],
        ['disabled', language.disabled],
    ] as const

    const isTypeSelected = (type:string) => selectedTypes.includes(type)

    function toggleOpen(){
        if(isOpen){
            onClose()
        } else {
            onOpen()
        }
    }
</script>

<ShDisclosureList
    variant="item"
    open={isOpen}
    onToggle={toggleOpen}
    dividerTone={embedded ? 'muted' : 'default'}
    data-disclosure-drag-name={value.comment.length === 0 ? 'Unnamed Script' : value.comment}
    data-risu-idx={idx}
>
    {#snippet header()}
        <span>{value.comment.length === 0 ? 'Unnamed Script' : value.comment}</span>
    {/snippet}
    {#snippet actions()}
        <IconButton size={actionIconSize} tone="destructive" data-disclosure-action="delete" aria-label={language.remove} onclick={async () => {
            const d = await alertConfirm(language.removeConfirm + value.comment)
            if(d){
                onRemove()
            }
        }}>
            <TrashIcon />
        </IconButton>
    {/snippet}

    <div data-disclosure-field>
        <div data-disclosure-label>{language.name}</div>
        <div data-disclosure-control>
            <TextInput bind:value={value.comment} oninput={(e) => {
                value.comment = e.currentTarget.value
                onSharedChange()
            }} onchange={(e) => {
                $ReloadGUIPointer += 1
            }} />
        </div>
    </div>
    <div data-disclosure-field>
        <div data-disclosure-label>{language.regexTarget}</div>
        <div data-disclosure-control>
            <TextInput bind:value={value.in} oninput={(e) => {
                value.in = e.currentTarget.value
                onSharedChange()
            }} />
        </div>
    </div>
    <div data-disclosure-field>
        <div data-disclosure-label>{language.regexOutput}</div>
        <div data-disclosure-control>
            <TextAreaInput highlight autocomplete="off" bind:value={value.out} onInput={(e) => {
                onSharedChange()
                $ReloadGUIPointer += 1
            }} />
        </div>
    </div>

    <div data-disclosure-field>
        <div data-disclosure-label>{language.scriptType}</div>
        <div data-disclosure-control>
            <div class="grid w-full grid-cols-2 overflow-hidden rounded-md border border-darkborderc">
                {#each scriptTypes as scriptType, i}
                    <button
                        type="button"
                        class={"w-full border-darkborderc py-2 text-sm transition-colors " +
                            (isTypeSelected(scriptType[0])
                                ? "bg-selected hover:bg-selected"
                                : "bg-darkbg hover:bg-darkborderc/30")}
                        class:border-r-1={i % 2 === 0}
                        class:border-b-1={i < scriptTypes.length - 2}
                        class:text-textcolor2={!isTypeSelected(scriptType[0])}
                        class:text-textcolor={isTypeSelected(scriptType[0])}
                        aria-pressed={isTypeSelected(scriptType[0])}
                        onclick={() => {
                            onToggleType(scriptType[0])
                            $ReloadGUIPointer += 1
                        }}
                    >
                        <span>{scriptType[1]}</span>
                    </button>
                {/each}
            </div>
        </div>
    </div>

    <div data-disclosure-row>
        <span class="text-sm text-textcolor">FLAGS</span>
        <ShSwitch
            checked={!!value.ableFlag}
            onCheckedChange={(checked) => {
                value.ableFlag = checked
                if(checked && !value.flag){
                    value.flag = 'g'
                }
                onSharedChange()
            }}
        />
    </div>
    {#if value.ableFlag}
        <div>
            <div class="grid w-full grid-cols-2 mt-2 mb-2 rounded-md border border-darkborderc overflow-hidden">
                {#each flags as flag, i}
                    <button
                        type="button"
                        class={"w-full border-darkborderc py-2 text-sm transition-colors " +
                            (checkFlagContain(flag[1], value.flag)
                                ? "bg-selected hover:bg-selected"
                                : "bg-darkbg hover:bg-darkborderc/30")}
                        class:border-r-1={i % 2 === 0}
                        class:border-b-1={i < flags.length - 2}
                        class:text-textcolor2={!checkFlagContain(flag[1], value.flag)}
                        class:text-textcolor={checkFlagContain(flag[1], value.flag)}
                        aria-pressed={checkFlagContain(flag[1], value.flag)}
                        onclick={() => {
                            toggleFlag(flag[1])
                        }}
                    >
                        <span>{flag[0]}</span>
                    </button>
                {/each}
            </div>

            <div data-disclosure-row>
                <span class="flex items-center text-sm text-textcolor">
                    {language.insertOrder}
                    <Help key="regexOrder"/>
                </span>
                <NumberInput
                    className="w-48 h-8 text-sm"
                    size="sm"
                    value={getOrder(value.flag)}
                    onChange={(e) => {
                        changeOrder(parseInt(e.currentTarget.value))
                    }}
                />
            </div>
        </div>
    {/if}
</ShDisclosureList>
