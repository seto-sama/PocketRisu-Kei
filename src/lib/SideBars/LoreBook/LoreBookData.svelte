<script lang="ts">
    import { TrashIcon, LinkIcon, SunIcon, MoonIcon, BookCopyIcon, FolderIcon, FolderOpen, PlusIcon } from "@lucide/svelte";
    import { v4 } from "uuid";
    import { language } from "../../../lang";
    import { getCurrentCharacter, getCurrentChat, type loreBook } from "../../../ts/storage/database.svelte";
    import { alertConfirm, alertMd } from "../../../ts/alert";
    import ShSwitch from "../../UI/GUI/ShSwitch.svelte";
    import Help from "../../Others/Help.svelte";
    import TextInput from "../../UI/GUI/TextInput.svelte";
    import NumberInput from "../../UI/GUI/NumberInput.svelte";
    import TextAreaInput from "../../UI/GUI/TextAreaInput.svelte";
    import SelectInput from "../../UI/GUI/SelectInput.svelte";
    import OptionInput from "../../UI/GUI/OptionInput.svelte";
    import { tokenizeAccurate } from "src/ts/tokenizer";
    import { DBState } from "src/ts/stores.svelte";
    import LoreBookList from "./LoreBookList.svelte";
    import ShDisclosureList from "../../UI/GUI/ShDisclosureList.svelte";
    import IconButton from "../../UI/GUI/IconButton.svelte";
    import IconButtonGroup from "../../UI/GUI/IconButtonGroup.svelte";

    interface Props {
        value: loreBook;
        onRemove?: () => void;
        onClose?: (isDetail?: boolean) => void;
        onOpen?: (isDetail?: boolean) => void;
        idx: number;
        externalLoreBooks?: loreBook[];
        idgroup: string;
        isOpen?: boolean;
        openFolders?: number;
        isLastInContainer?: boolean;
        moduleMode?: boolean;
        openedRefs?: Set<loreBook>;
        listEditMode?: boolean;
    }

    let {
        value = $bindable(),
        onRemove = () => {},
        onClose = (isDetail = true) => {},
        onOpen = (isDetail = true) => {},
        idx,
        externalLoreBooks = $bindable(),
        idgroup,
        isOpen = false,
        openFolders = 0,
        isLastInContainer = false,
        moduleMode = false,
        openedRefs = $bindable(new Set<loreBook>()),
        listEditMode = $bindable(false),
    }: Props = $props();
    
    let open = $derived(isOpen)
    const itemIconSize = 18

    let tokens = $state(0)
    let tokenTimer: ReturnType<typeof setTimeout> | null = null
    let tokenSeq = 0
    // Re-count tokens on a debounce instead of on every content change — the
    // tokenizer runs a full CBS parse + encode, which is too heavy to do live.
    // Only when this entry is open: the token count UI renders only while open,
    // so closed entries (a big lorebook can have hundreds) must not tokenize.
    // The generation is bumped here (on content change), not in the timer, so an
    // in-flight tokenize is invalidated the moment the input changes — not only
    // once the next debounce fires 400ms later.
    $effect(() => {
        if (!open) return
        const content = value.content
        const seq = ++tokenSeq
        if (tokenTimer) clearTimeout(tokenTimer)
        tokenTimer = setTimeout(() => {
            tokenizeAccurate(content).then(result => { if (seq === tokenSeq) tokens = result })
        }, 400)
        return () => { if (tokenTimer) clearTimeout(tokenTimer) }
    })

    function isLocallyActivated(book: loreBook){
        return book.id ? getCurrentChat()?.localLore.some(e => e.id === book.id) : false
    }
    function activateLocally(book: loreBook){
        if(!book.id){
            book.id = v4()
        }
        
        const childLore: loreBook = {
            key: '',
            comment: '',
            content: '',
            mode: 'child',
            insertorder: 100,
            alwaysActive: true,
            secondkey: '',
            selective: false,
            id: book.id,
        }
        getCurrentChat().localLore.push(childLore)
    }
    function deactivateLocally(book: loreBook){
        if(!book.id) return
        const chat = getCurrentChat()
        const childLore = chat?.localLore?.find(e => e.id === book.id)
        if(childLore){
            chat.localLore = chat.localLore.filter(e => e.id !== book.id)
        }
    }
    function toggleLocalActive(check: boolean, book: loreBook){
        if(check){
            activateLocally(book)
        }else{
            deactivateLocally(book)
        }
    }
    function getParentLoreName(book: loreBook){
        if(book.mode === 'child'){
            const value = getCurrentCharacter()?.globalLore.find(e => e.id === book.id)
            if(value){
                return value.comment.length === 0 ? value.key.length === 0 ? "Unnamed Lore" : value.key : value.comment
            }
        }
    }

    function toggleOpen(){
        if(listEditMode && value.mode !== 'child'){
            return
        }

        if(value.mode === 'child'){
            void alertMd(language.childLoreDesc)
            return
        }

        value.secondkey = value.secondkey ?? ''
        open = !open
        if(open){
            onOpen(value.mode !== 'folder')
        }
        else{
            onClose(value.mode !== 'folder')
        }
    }

    async function removeEntry(){
        if(value.mode === 'child'){
            const confirmed = await alertConfirm(language.removeConfirm + getParentLoreName(value))
            if(confirmed){
                if(!open){
                    onClose()
                }
                onRemove()
            }
            return
        }

        if(value.mode === 'folder' && externalLoreBooks.some(e => e.folder === value.key)){
            const confirmed = await alertConfirm(language.folderRemoveConfirm)
            if(!confirmed){
                return
            }
        }

        const confirmed = await alertConfirm(language.removeConfirm + (value.comment || 'Unnamed Folder'))
        if(confirmed){
            if(!open){
                onClose()
            }
            deactivateLocally(value)
            onRemove()
        }
    }

</script>
<ShDisclosureList
    variant="item"
    open={open}
    disclosure={value.mode !== 'child'}
    isLast={isLastInContainer}
    onToggle={toggleOpen}
    className={value.mode === 'folder' && openFolders > 0 ? 'no-sort' : ''}
    bodyPadded={value.mode !== 'folder'}
    bodyClass={value.mode === 'folder' ? 'mb-2' : ''}
    data-disclosure-drag-name={value.mode === 'child'
        ? getParentLoreName(value)
        : value.mode === 'folder'
            ? value.comment || 'Unnamed Folder'
            : value.comment || value.key || 'Unnamed Lore'}
    data-risu-idx={idx} data-risu-idgroup={idgroup}
>
    {#snippet header()}
        {#if value.mode === 'child'}
            <BookCopyIcon size={itemIconSize} class="mr-1" />
            <span>{getParentLoreName(value)}</span>
        {:else}
            {#if value.mode === 'folder'}
                {#if open}
                    <FolderOpen size={itemIconSize} class="mr-2 shrink-0" />
                {:else}
                    <FolderIcon size={itemIconSize} class="mr-2 shrink-0" />
                {/if}
            {/if}
            {#if listEditMode}
                <div class="min-w-0 grow">
                    <TextInput
                        bind:value={value.comment}
                        className="h-6 min-w-0 px-2"
                        padding={false}
                        fullwidth
                        onkeydown={(event) => event.stopPropagation()}
                    />
                </div>
            {:else if value.mode === 'folder'}
                <span>{value.comment.length === 0 ? "Unnamed Folder" : value.comment}</span>
            {:else}
                <span>{value.comment.length === 0 ? value.key.length === 0 ? "Unnamed Lore" : value.key : value.comment}</span>
            {/if}
        {/if}
    {/snippet}
    {#snippet actions()}
        <IconButtonGroup size="default" className="ml-3 shrink-0">
            {#if value.mode !== 'child'}
                <IconButton
                    active={value.alwaysActive || value.selective}
                    aria-label={value.alwaysActive ? language.alwaysActive : value.selective ? language.selective : language.activationKeys}
                    onclick={() => {
                        if(value.mode === 'folder'){
                            for(let i = 0; i < externalLoreBooks.length; i++){
                                if(externalLoreBooks[i].folder === value.key){
                                    externalLoreBooks[i].alwaysActive = !value.alwaysActive
                                }
                            }
                            value.alwaysActive = !value.alwaysActive
                            return
                        }
                        if(value.alwaysActive || value.selective){
                            value.alwaysActive = false
                            value.selective = false
                        }
                        else{
                            value.alwaysActive = true
                            value.selective = false
                        }
                    }}
                    oncontextmenu={(event) => {
                        event.preventDefault()
                        if(value.mode === 'folder'){
                            return
                        }
                        if(value.alwaysActive || value.selective){
                            value.alwaysActive = false
                            value.selective = false
                        }
                        else{
                            value.alwaysActive = false
                            value.selective = true
                            value.useRegex = false
                        }
                    }}
                >
                    {#if value.alwaysActive}
                        <SunIcon />
                    {:else if value.selective}
                        <MoonIcon />
                    {:else}
                        <LinkIcon />
                    {/if}
                </IconButton>
            {/if}
            <IconButton tone="destructive" data-disclosure-action="delete" aria-label={language.remove} onclick={removeEntry}>
                <TrashIcon />
            </IconButton>
        </IconButtonGroup>
    {/snippet}

    {#if value.mode === 'folder'}
        <div class="border-0 outline-hidden w-full flex flex-col">
            <LoreBookList externalLoreBooks={externalLoreBooks} showFolder={value.key} {moduleMode} bind:openedRefs bind:listEditMode />
            
            <div class="mt-2 flex">
                <IconButton size="default" onclick={() => {
                    externalLoreBooks.push({
                        key: '',
                        comment: '',
                        content: '',
                        mode: 'normal',
                        insertorder: 100,
                        alwaysActive: true,
                        secondkey: '',
                        selective: false,
                        folder: value.key,
                    })
                }}>
                    <PlusIcon />
                </IconButton>
            </div>
        </div>
    {:else}
        <div class="border-0 outline-hidden w-full flex flex-col">
            <div data-disclosure-field>
                <div data-disclosure-label class="justify-between">
                    <span>{language.name}<Help key="loreName"/></span>
                    <Help key="loreActivationMode" name={language.activationKeys}/>
                </div>
                <div data-disclosure-control><TextInput bind:value={value.comment}/></div>
            </div>

            {#if !value.alwaysActive}
                <div data-disclosure-field>
                    <div data-disclosure-label>{language.activationKeys}<Help key="loreActivationKey"/></div>
                    <div data-disclosure-control><TextInput bind:value={value.key}/></div>
                </div>

                {#if value.selective}
                    <div data-disclosure-field>
                        <div data-disclosure-label>{language.SecondaryKeys}<Help key="loreSelective"/></div>
                        <div data-disclosure-control><TextInput bind:value={value.secondkey}/></div>
                    </div>
                {/if}
            {/if}

            <div data-disclosure-field>
                <div data-disclosure-label>{language.insertOrder}<Help key="loreorder"/></div>
                <div data-disclosure-control><NumberInput bind:value={value.insertorder} min={0} max={1000}/></div>
            </div>

            <div data-disclosure-field>
                <div data-disclosure-label>{language.role}</div>
                <div data-disclosure-control>
                    <SelectInput value={value.role ?? 'system'} onchange={(e) => {
                        value.role = e.currentTarget.value as 'system'|'user'|'assistant'
                    }}>
                        <OptionInput value="system">{language.systemPrompt}</OptionInput>
                        <OptionInput value="user">{language.user}</OptionInput>
                        <OptionInput value="assistant">{language.character}</OptionInput>
                    </SelectInput>
                </div>
            </div>

            <div data-disclosure-field>
                <div data-disclosure-label>{language.prompt}</div>
                <div data-disclosure-control><TextAreaInput highlight autocomplete="off" bind:value={value.content} /></div>
            </div>
            <span class="text-textcolor2 mb-2 text-sm">{tokens} {language.tokens}</span>

            {#if !moduleMode && !(value.activationPercent === undefined || value.activationPercent === null)}
                <div data-disclosure-field>
                    <div data-disclosure-label>{language.activationProbability}</div>
                    <div data-disclosure-control>
                        <NumberInput bind:value={value.activationPercent} onChange={() => {
                            if(isNaN(value.activationPercent) || !value.activationPercent || value.activationPercent < 0){
                                value.activationPercent = 0
                            }
                            if(value.activationPercent > 100){
                                value.activationPercent = 100
                            }
                        }} />
                    </div>
                </div>
            {/if}

            {#if !value.alwaysActive && getCurrentCharacter()?.globalLore?.includes(value) && DBState.db.localActivationInGlobalLorebook}
                <div data-disclosure-row>
                    <span class="text-sm text-textcolor">{language.alwaysActiveInChat}</span>
                    <ShSwitch checked={isLocallyActivated(value)} onCheckedChange={(checked) => toggleLocalActive(checked, value)} />
                </div>
            {/if}
            {#if !value.alwaysActive}
                <div data-disclosure-row>
                    <span class="flex items-center text-sm text-textcolor">
                        {language.useRegexLorebook}
                        <Help key="useRegexLorebook"/>
                    </span>
                    <ShSwitch checked={value.useRegex} onCheckedChange={(checked) => {
                        value.useRegex = checked
                    }} />
                </div>
            {/if}
        </div>
    {/if}
</ShDisclosureList>
