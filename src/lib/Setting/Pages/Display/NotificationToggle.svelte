<script lang="ts">
    import { language } from 'src/lang';
    import { notifyError } from 'src/ts/alert';
    import { DBState } from 'src/ts/stores.svelte';
    import ShSwitch from 'src/lib/UI/GUI/ShSwitch.svelte';
    import SoundRow from '../Sound/SoundRow.svelte';

    async function onToggle(check: boolean) {
        DBState.db.notification = check;
        if (!check) {
            return;
        }
        let hasPermission = { state: 'denied' };
        try {
            hasPermission = await navigator.permissions.query({ name: 'notifications' });
        } catch (error) {
            // Some browsers do not support the Permissions API.
        }
        if (hasPermission.state === 'denied') {
            const permission = await Notification.requestPermission();
            if (permission === 'denied') {
                notifyError(language.permissionDenied);
                DBState.db.notification = false;
            }
        }
    }
</script>

<SoundRow label={language.notificationEnable} description={language.help.descBrowserNotification}>
    <ShSwitch checked={DBState.db.notification} onCheckedChange={onToggle} />
</SoundRow>
