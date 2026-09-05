<script lang="ts">
    import { DBState, selectedCharID } from 'src/ts/stores.svelte';
    import { safeStructuredClone } from 'src/ts/polyfill';
    import { emptyModelBinding } from 'src/ts/preset/types';
    import ModelPresetList from './ModelPresetList.svelte';

    interface Props {
        open?: boolean;
    }

    let { open = $bindable(false) }: Props = $props();

    const currentChat = $derived(
        DBState.db.characters[$selectedCharID]?.chats?.[DBState.db.characters[$selectedCharID]?.chatPage]
    );
    const activePresetId = $derived(
        currentChat?.modelBinding?.main ?? DBState.db.defaultModelBinding?.main ?? ''
    );

    function selectPreset(id: string) {
        if (!currentChat) return;
        currentChat.modelBinding ??= DBState.db.defaultModelBinding
            ? safeStructuredClone(DBState.db.defaultModelBinding)
            : emptyModelBinding();
        currentChat.modelBinding.main = id;
    }
</script>

<ModelPresetList
    pickerOnly
    bind:open
    value={activePresetId}
    onChange={selectPreset}
/>
