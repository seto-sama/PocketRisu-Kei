<script lang="ts">
    import { DBState } from 'src/ts/stores.svelte';
    import { language } from "src/lang";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import ShAccordion from "src/lib/UI/GUI/ShAccordion.svelte";
    import Help from "src/lib/Others/Help.svelte";

    const characterSets = [
        'Latn', 'Hani', 'Arab', 'Deva', 'Cyrl', 'Beng', 'Hira', 'Kana', 'Telu', 'Hang',
        'Taml', 'Thai', 'Gujr', 'Knda', 'Ethi', 'Khmr', 'Grek', 'Hebr',
    ];

    const characterSetsPreview: Record<string, string> = {
        'Latn': "ABC", 'Hani': "汉漢", 'Arab': "اعب", 'Deva': "अआइ", 'Cyrl': "АБВ",
        'Beng': "অআই", 'Hira': "あい", 'Kana': "アイ", 'Telu': "అఆఇ", 'Hang': "가나다",
        'Taml': "அஆஇ", 'Thai': "กขค", 'Gujr': "અઆઇ", 'Knda': "ಅಆಇ", 'Ethi': "ሀሁሂ",
        'Khmr': "កខគ", 'Grek': "ΑΒΓ", 'Hebr': "אבג",
    };
</script>

{#snippet helpExtras()}
    <Help key="banCharacterset" name={language.banCharacterset} />
{/snippet}

<ShAccordion name={language.banCharacterset} variant="card" class="mt-2" extras={helpExtras}>
    <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {#each characterSets as set}
            <ShButton
                className={`w-full justify-start whitespace-normal${DBState.db.banCharacterset.includes(set) ? '' : ' text-textcolor2'}`}
                size="sm"
                variant={DBState.db.banCharacterset.includes(set) ? 'primary' : "outline"}
                onclick={() => {
                    if (DBState.db.banCharacterset.includes(set)) {
                        DBState.db.banCharacterset = DBState.db.banCharacterset.filter((item) => item !== set)
                    } else {
                        DBState.db.banCharacterset.push(set)
                    }
                }}
            >
                {new Intl.DisplayNames([navigator.language, 'en'], { type: 'script' }).of(set)} ({characterSetsPreview[set]})
            </ShButton>
        {/each}
    </div>
</ShAccordion>
