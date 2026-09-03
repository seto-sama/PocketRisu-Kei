<script lang="ts">
    import type { Snippet } from 'svelte';
    import type { SettingItem } from 'src/ts/setting/types';
    import { getLabel } from 'src/ts/setting/utils';
    import { language } from 'src/lang';
    import SettingRow from './SettingRow.svelte';

    interface Props {
        item: SettingItem;
        control?: Snippet;
    }

    let { item, control }: Props = $props();

    const helpText = $derived(
        item.helpKey ? (language.help as any)[item.helpKey] : item.description
    );
</script>

<SettingRow
    title={getLabel(item)}
    description={helpText}
    settingId={item.id}
    {control}
/>
