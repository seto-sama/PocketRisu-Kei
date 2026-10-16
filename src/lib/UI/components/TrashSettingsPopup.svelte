<script lang="ts">
    import type { Snippet } from 'svelte';
    import { language } from 'src/lang';
    import { DBState } from 'src/ts/stores.svelte';
    import { normalizeTrashRetentionDays } from 'src/ts/trashRetention';
    import type { SettingItem } from 'src/ts/setting/types';
    import SettingNumber from '../../Setting/Wrappers/SettingNumber.svelte';
    import MiniSettingsPopup from './MiniSettingsPopup.svelte';

    let { trigger }: { trigger: Snippet } = $props();

    const retentionSetting: SettingItem = $derived({
        id: 'trashRetentionDays',
        type: 'number',
        labelKey: 'trashAutoDeleteSchedule',
        helpKey: 'trashAutoDeleteSchedule',
        getValue: (db) => normalizeTrashRetentionDays(db.trashRetentionDays),
        setValue: (db, value) => { db.trashRetentionDays = normalizeTrashRetentionDays(value); },
        options: { min: 0, suffix: language.trashRetentionDaysSuffix },
    });
</script>

<MiniSettingsPopup {trigger}>
    <SettingNumber item={retentionSetting} ctx={{ db: DBState.db, layout: 'row' }} />
</MiniSettingsPopup>
