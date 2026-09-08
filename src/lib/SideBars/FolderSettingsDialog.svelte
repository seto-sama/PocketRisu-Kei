<script lang="ts">
    import { language } from 'src/lang';
    import { DBState, ReloadGUIPointer } from 'src/ts/stores.svelte';
    import type { FolderDisplayMode, folder as CharacterFolder } from 'src/ts/storage/database.svelte';
    import { alertConfirm, alertError } from 'src/ts/alert';
    import { requestImmediateSave } from 'src/ts/globalApi.svelte';
    import Dialog from '../UI/components/Dialog.svelte';
    import Input from '../UI/components/Input.svelte';
    import Button from '../UI/components/Button.svelte';
    import { iconButtonSizeValues } from '../UI/components/IconButton.svelte';
    import { ImageIcon, TrashIcon } from '@lucide/svelte';
    import Select from '../UI/components/Select.svelte';
    import SelectOption from '../UI/components/SelectOption.svelte';
    import SettingRow from '../Setting/Wrappers/SettingRow.svelte';
    import Switch from '../UI/components/Switch.svelte';
    import FolderAvatar from './FolderAvatar.svelte';
    import { folderDisplayMode } from './folderDisplay';
    import { folderColorOptions, getFolderColorStyle } from './folderColors';
    import { FOLDER_ICONS, FOLDER_ICON_NAMES } from './folderIcons';
    import {
        chatFolderSettingsTarget,
        deleteChatFolder,
        findChatFolder,
        folderSettingsTarget,
        findSidebarFolder,
        updateChatFolder,
        updateSidebarFolder,
        pickSidebarFolderImage,
    } from './sidebarFolderMenu';

    type FolderSettingsPatch = Partial<Pick<CharacterFolder, 'name' | 'color' | 'localOnly' | 'nodeOnlyDisplay' | 'nodeOnlyIcon'>>;

    const characterFolder = $derived($folderSettingsTarget ? findSidebarFolder($folderSettingsTarget) : undefined);
    const chatFolder = $derived($chatFolderSettingsTarget
        ? findChatFolder($chatFolderSettingsTarget.characterId, $chatFolderSettingsTarget.folderId)
        : undefined);
    const target = $derived(characterFolder ?? chatFolder);
    const isChatFolder = $derived(!!chatFolder && !characterFolder);
    const mode = $derived(characterFolder ? folderDisplayMode(characterFolder, DBState.db.showFolderName) : 'icon');
    let uploading = $state(false);
    const previewSize = 176;
    const folderIconSize = iconButtonSizeValues.default.icon;

    function updateTarget(patch: FolderSettingsPatch) {
        if (isChatFolder && $chatFolderSettingsTarget) {
            updateChatFolder(
                $chatFolderSettingsTarget.characterId,
                $chatFolderSettingsTarget.folderId,
                patch,
            );
        } else if ($folderSettingsTarget) {
            updateSidebarFolder($folderSettingsTarget, patch);
        }
    }

    async function pickImage() {
        const id = $folderSettingsTarget;
        if (!id || isChatFolder || uploading) return;
        uploading = true;
        try { await pickSidebarFolderImage(id); }
        catch (error) { alertError(error); }
        finally { uploading = false; }
    }

    async function removeChatFolder() {
        const settingsTarget = $chatFolderSettingsTarget;
        if (!settingsTarget || !await alertConfirm(language.chatFolderDeleteConfirm)) return;
        if (!deleteChatFolder(settingsTarget.characterId, settingsTarget.folderId)) return;

        $ReloadGUIPointer += 1;
        void requestImmediateSave({ characterIds: [settingsTarget.characterId] });
        chatFolderSettingsTarget.set(null);
    }
</script>

{#snippet chatFolderFooter()}
    <div class="w-full flex justify-end">
        <Button variant="destructive" size="sm" title={language.remove} onclick={removeChatFolder}>
            <TrashIcon />
            {language.remove}
        </Button>
    </div>
{/snippet}

<Dialog
    open={!!target}
    footer={isChatFolder ? chatFolderFooter : undefined}
    onOpenChange={(open) => {
        if (!open) {
            folderSettingsTarget.set(null);
            chatFolderSettingsTarget.set(null);
        }
    }}
    size="lg"
>
    {#snippet title()}{language.folderSettings}{/snippet}
    {#if target}
        <div class="flex items-start gap-5 max-sm:flex-col" style={`--folder-preview-size: ${previewSize}px`}>
            <div class="flex w-[var(--folder-preview-size)] shrink-0 flex-col items-center gap-4 max-sm:self-center">
                <FolderAvatar folder={target} size={String(previewSize)} interactive={false} showTooltip={false} />
                {#if mode === 'image'}
                    <Button variant="outline" size="sm" className="w-full" title={language.selectImage} disabled={uploading} onclick={pickImage}>
                        <ImageIcon />{language.select}
                    </Button>
                {/if}
            </div>
            <div class="grid h-[var(--folder-preview-size)] min-w-0 grow auto-rows-fr max-sm:w-full">
                <SettingRow title={language.name} className="border-0 py-0">
                    {#snippet control()}
                        <Input size="sm" className="w-48" aria-label={language.name} value={target.name ?? ''} oninput={(event) => updateTarget({ name: event.currentTarget.value })} />
                    {/snippet}
                </SettingRow>
                {#if !isChatFolder}
                    <SettingRow title={language.folderDisplayMode} className="border-0 py-0">
                        {#snippet control()}
                            <Select size="sm" className="w-48" bind:value={() => mode, (value) => updateTarget({ nodeOnlyDisplay: value as FolderDisplayMode })}>
                                <SelectOption value="icon">{language.folderModeIcon}</SelectOption>
                                <SelectOption value="image">{language.folderModeImage}</SelectOption>
                                <SelectOption value="name">{language.folderModeName}</SelectOption>
                            </Select>
                        {/snippet}
                    </SettingRow>
                {/if}
                <SettingRow title={language.folderColor} className="border-0 py-0">
                    {#snippet control()}
                        <div class="flex w-48 flex-nowrap justify-between">
                            {#each folderColorOptions as color (color.value)}
                                <button type="button" class="size-4.5 shrink-0 rounded-md border transition-colors {target.color === color.value || (!target.color && color.value === 'default') ? 'border-lightborderc' : 'border-darkborderc hover:border-lightborderc/70'}"
                                    style:background-color={color.value === 'default' ? 'var(--risu-theme-darkbg)' : getFolderColorStyle(color.value).accent}
                                    title={color.label} aria-label={color.label} aria-pressed={target.color === color.value || (!target.color && color.value === 'default')}
                                    onclick={() => updateTarget({ color: color.value })}></button>
                            {/each}
                        </div>
                    {/snippet}
                </SettingRow>
                <SettingRow title={language.hideFolderOnRemoteAccess} className="border-0 py-0">
                    {#snippet control()}
                        <Switch checked={!!target.localOnly} onCheckedChange={(localOnly) => updateTarget({ localOnly })} ariaLabel={language.hideFolderOnRemoteAccess} />
                    {/snippet}
                </SettingRow>
            </div>
        </div>
        {#if mode === 'icon'}
            <div class="mt-4 grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1 rounded-md border border-darkborderc p-2 max-h-48 overflow-y-auto">
                {#each FOLDER_ICON_NAMES as name (name)}
                    {@const Icon = FOLDER_ICONS[name]}
                    <button type="button" class="flex aspect-square w-full items-center justify-center rounded-md {(target.nodeOnlyIcon ?? 'folder') === name ? 'bg-selected text-maintext' : 'text-subtext risu-interactive-surface'}"
                        title={name} aria-label={name} aria-pressed={(target.nodeOnlyIcon ?? 'folder') === name} onclick={() => updateTarget({ nodeOnlyIcon: name === 'folder' ? undefined : name })}><Icon size={folderIconSize} /></button>
                {/each}
            </div>
        {/if}
    {/if}
</Dialog>
