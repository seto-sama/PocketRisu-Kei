<script lang="ts">
    import { TrashIcon, LinkIcon, SunIcon, MoonIcon, BookCopyIcon, FolderIcon, FolderOpenIcon, PlusIcon, PencilIcon } from "@lucide/svelte";
    import { createEntityId } from 'src/ts/id';
    import { language } from "../../../lang";
    import { getCurrentCharacter, getCurrentChat, type loreBook } from "../../../ts/storage/database.svelte";
    import { alertConfirm, alertMd } from "../../../ts/alert";
    import Switch from "../../UI/components/Switch.svelte";
    import Help from "../../Others/Help.svelte";
    import Input from "../../UI/components/Input.svelte";
    import InlineEditableName from "../../UI/components/InlineEditableName.svelte";
    import NumberInput from "../../UI/components/NumberInput.svelte";
    import Textarea from "../../UI/components/Textarea.svelte";
    import { DBState } from "src/ts/stores.svelte";
    import LoreBookList from "./LoreBookList.svelte";
    import DisclosureList from "../../UI/components/DisclosureList.svelte";
    import IconButton, { iconButtonEdgeInset, iconButtonSizeValues } from "../../UI/components/IconButton.svelte";
    import IconButtonGroup from "../../UI/components/IconButtonGroup.svelte";
    import TokenCount from "../../UI/components/TokenCount.svelte";
    import InlineRenameAction from "../../UI/components/InlineRenameAction.svelte";
    import { InlineEditableNameController } from "../../UI/components/InlineEditableNameController.svelte";
    import PopupButton from "../../UI/PopupButton.svelte";
    import { Item as DropdownMenuItem } from "../../UI/components/dropdown-menu";
    import { mdViewport } from "src/ts/gui/breakpoints";

    interface Props {
        value: loreBook;
        onRemove?: () => void;
        onClose?: (isDetail?: boolean) => void;
        onOpen?: (isDetail?: boolean) => void;
        idx: number;
        externalLoreBooks?: loreBook[];
        idgroup: string;
        isOpen?: boolean;
        isLastInContainer?: boolean;
        moduleMode?: boolean;
        openedRefs?: Set<loreBook>;
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
        isLastInContainer = false,
        moduleMode = false,
        openedRefs = $bindable(new Set<loreBook>()),
    }: Props = $props();
    const renameController = new InlineEditableNameController();
    
    let open = $derived(isOpen)
    const showEntryDivider = $derived(value.mode !== 'folder' && open && !isLastInContainer)
    const itemIconSize = iconButtonSizeValues.default.icon
    const mobile = $derived(!$mdViewport)

    function isLocallyActivated(book: loreBook){
        return book.id ? getCurrentChat()?.localLore.some(e => e.id === book.id) : false
    }
    function activateLocally(book: loreBook){
        if(!book.id){
            book.id = createEntityId()
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

    function addLorebookToFolder() {
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
    }

    function toggleActivation() {
        if(value.mode === 'folder'){
            for(const lore of externalLoreBooks){
                if(lore.folder === value.key){
                    lore.alwaysActive = !value.alwaysActive
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
    }

    function toggleSelective(event: MouseEvent) {
        event.preventDefault()
        if(value.mode === 'folder') return
        if(value.alwaysActive || value.selective){
            value.alwaysActive = false
            value.selective = false
        }
        else{
            value.alwaysActive = false
            value.selective = true
            value.useRegex = false
        }
    }

</script>

{#snippet alwaysActiveAction()}
    <IconButton
        active={value.alwaysActive || value.selective}
        aria-label={value.alwaysActive ? language.alwaysActive : value.selective ? language.selective : language.activationKeys}
        onclick={toggleActivation}
        oncontextmenu={toggleSelective}
    >
        {#if value.alwaysActive}
            <SunIcon />
        {:else if value.selective}
            <MoonIcon />
        {:else}
            <LinkIcon />
        {/if}
    </IconButton>
{/snippet}

{#snippet mobileActions()}
    <PopupButton>
        {#if value.mode !== 'child'}
            <DropdownMenuItem disabled={renameController.editing} onSelect={() => renameController.startEditing()}>
                <PencilIcon />
                <span>{language.togglePresetMenuRename}</span>
            </DropdownMenuItem>
        {/if}
        {#if value.mode === 'folder'}
            <DropdownMenuItem onSelect={addLorebookToFolder}>
                <PlusIcon />
                <span>{language.add}</span>
            </DropdownMenuItem>
        {/if}
        <DropdownMenuItem variant="destructive" onSelect={() => { void removeEntry() }}>
            <TrashIcon />
            <span>{language.remove}</span>
        </DropdownMenuItem>
    </PopupButton>
{/snippet}

<DisclosureList
    variant="item"
    appearance={value.mode === 'folder' ? 'folder' : 'row'}
    data-tree-item
    data-tree-expanded={value.mode !== 'folder' && open ? 'true' : undefined}
    open={open}
    disclosure={value.mode !== 'child'}
    isLast={isLastInContainer}
    onToggle={toggleOpen}
    className={showEntryDivider ? 'pb-1' : ''}
    data-lore-mode={value.mode}
    bodyPadded={value.mode !== 'folder'}
    bodyClass={value.mode === 'folder' ? 'mb-1' : (showEntryDivider ? 'border-b border-selected' : '')}
    data-disclosure-drag-name={value.mode === 'child'
        ? getParentLoreName(value)
        : value.mode === 'folder'
            ? value.comment || 'Unnamed Folder'
            : value.comment || value.key || 'Unnamed Lore'}
    data-risu-idx={idx} data-risu-idgroup={idgroup}
    inlineRenameRow
>
    {#snippet header()}
        {#if value.mode === 'child'}
            <BookCopyIcon size={itemIconSize} class="mr-1" />
            <span>{getParentLoreName(value)}</span>
        {:else}
            {#if value.mode === 'folder'}
                {#if open}
                    <FolderOpenIcon size={itemIconSize} class="risu-folder-icon mr-2 shrink-0" />
                {:else}
                    <FolderIcon size={itemIconSize} class="risu-folder-icon mr-2 shrink-0" />
                {/if}
            {/if}
            <InlineEditableName
                size="row"
                editorLeadingInset={value.mode === 'folder' ? 'border' : 'row'}
                controller={renameController}
                bind:value={value.comment}
                label={value.mode === 'folder'
                    ? value.comment || 'Unnamed Folder'
                    : value.comment || value.key || 'Unnamed Lore'}
                onActivate={toggleOpen}
            />
        {/if}
    {/snippet}
    {#snippet actions()}
        <IconButtonGroup
            size="default"
            className="ml-3 shrink-0"
            style={`margin-right:-${iconButtonEdgeInset(mobile ? 'lg' : 'default')}px`}
        >
            {#if !mobile}
                <InlineRenameAction controller={renameController} />
                {#if value.mode === 'folder'}
                    <IconButton aria-label={language.add} onclick={addLorebookToFolder}>
                        <PlusIcon />
                    </IconButton>
                {/if}
            {/if}
            {#if value.mode !== 'child'}
                {@render alwaysActiveAction()}
            {/if}
            {#if !mobile}
                <IconButton tone="destructive" data-disclosure-action="delete" aria-label={language.remove} onclick={removeEntry}>
                    <TrashIcon />
                </IconButton>
            {:else}
                {@render mobileActions()}
            {/if}
        </IconButtonGroup>
    {/snippet}

    {#if value.mode === 'folder'}
        <div class="border-0 outline-hidden w-full flex flex-col">
            <LoreBookList externalLoreBooks={externalLoreBooks} showFolder={value.key} {moduleMode} bind:openedRefs />
        </div>
    {:else}
        <div class="border-0 outline-hidden w-full flex flex-col">
            <div data-disclosure-field>
                <div data-disclosure-label class="justify-between">
                    <span>{language.name}<Help key="loreName"/></span>
                    <Help key="loreActivationMode" name={language.activationKeys}/>
                </div>
                <div data-disclosure-control><Input bind:value={value.comment}/></div>
            </div>

            {#if !value.alwaysActive}
                <div data-disclosure-field>
                    <div data-disclosure-label>{language.activationKeys}<Help key="loreActivationKey"/></div>
                    <div data-disclosure-control><Input bind:value={value.key}/></div>
                </div>

                {#if value.selective}
                    <div data-disclosure-field>
                        <div data-disclosure-label>{language.SecondaryKeys}<Help key="loreSelective"/></div>
                        <div data-disclosure-control><Input bind:value={value.secondkey}/></div>
                    </div>
                {/if}
            {/if}

            <div data-disclosure-field>
                <div data-disclosure-label>{language.insertOrder}<Help key="loreorder"/></div>
                <div data-disclosure-control><NumberInput bind:value={value.insertorder} min={0} max={1000}/></div>
            </div>

            <div data-disclosure-field>
                <div data-disclosure-label>{language.prompt}</div>
                <div data-disclosure-control><Textarea autocomplete="off" bind:value={value.content} popupTitle={value.comment || language.prompt} /></div>
            </div>
            <TokenCount value={value.content} className="mb-2" />

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

            {#if !value.alwaysActive}
                <div class="my-2 flex flex-col gap-2">
                    {#if getCurrentCharacter()?.globalLore?.includes(value) && DBState.db.localActivationInGlobalLorebook}
                        <div class="flex items-center justify-between">
                            <span class="text-sm text-maintext">{language.alwaysActiveInChat}</span>
                            <Switch checked={isLocallyActivated(value)} onCheckedChange={(checked) => toggleLocalActive(checked, value)} />
                        </div>
                    {/if}
                    <div class="flex items-center justify-between">
                        <span class="flex items-center text-sm text-maintext">
                            {language.useRegexLorebook}
                            <Help key="useRegexLorebook"/>
                        </span>
                        <Switch checked={value.useRegex} onCheckedChange={(checked) => {
                            value.useRegex = checked
                        }} />
                    </div>
                </div>
            {/if}
        </div>
    {/if}
</DisclosureList>
