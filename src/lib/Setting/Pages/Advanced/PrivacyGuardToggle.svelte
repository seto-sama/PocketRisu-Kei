<script lang="ts">
    import { language } from 'src/lang';
    import { alertConfirm, alertError, alertPassword } from 'src/ts/alert';
    import { requestImmediateSave } from 'src/ts/globalApi.svelte';
    import { isPrivacyGuardActive } from 'src/ts/platform';
    import { enableKeiClipboardForPrivacyGuard, restoreKeiClipboardAfterPrivacyGuard } from 'src/ts/clipboard/keiClipboard.svelte';
    import { forageStorage } from 'src/ts/storage/autoStorage';
    import Switch from '../../../UI/components/Switch.svelte';
    import SettingRow from '../../Wrappers/SettingRow.svelte';

    let checked = $state(isPrivacyGuardActive);
    let busy = $state(false);

    // The switch stays disabled while busy, so each change is the opposite of the current mode.
    async function onToggle(enable: boolean) {
        busy = true;
        let switched = false;
        try {
            if (enable && !(await alertConfirm(language.privacyGuard.enableConfirm))) return;
            const password = enable ? '' : await alertPassword(language.privacyGuard.disablePasswordPrompt);
            if (!enable && !password) return;
            if (enable) enableKeiClipboardForPrivacyGuard();
            // Save under the current projection before the server switches what this client may see.
            await requestImmediateSave({ requireSuccess: true });
            await forageStorage.Init();
            if (enable) await forageStorage.realStorage.enablePrivacyGuard();
            else await forageStorage.realStorage.disablePrivacyGuard(password);
            switched = true;
            location.reload();
        } catch (error) {
            if (enable) restoreKeiClipboardAfterPrivacyGuard();
            alertError(error);
        } finally {
            busy = false;
            if (!switched) checked = isPrivacyGuardActive;
        }
    }
</script>

<SettingRow title={language.privacyGuardMode} description={language.privacyGuard.description}>
    {#snippet control()}
        <Switch bind:checked disabled={busy} onCheckedChange={onToggle} ariaLabel={language.privacyGuardMode} />
    {/snippet}
</SettingRow>
