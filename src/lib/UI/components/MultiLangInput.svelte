<script lang="ts">
    import { encodeMultilangString, languageCodes, parseMultilangString, toLangName } from "src/ts/util";
    import Button from "./Button.svelte";
    import Textarea from "./Textarea.svelte";
    let selectedLang = $state("en")
    interface Props {
        value: string;
        addingLang?: boolean;
        className?: string;
        onInput?: any;
    }

    let { value = $bindable(), addingLang = $bindable(false), className = "", onInput = () => {} }: Props = $props();

    // Overridden locally while a newly added language has no text yet.
    let valueObject: {[code:string]:string} = $derived(parseMultilangString(value))

    function commit(entries: {[code:string]:string}) {
        const next = { ...entries }
        for(const lang in next){
            if(next[lang] === "" && lang !== selectedLang && lang !== "en"){
                delete next[lang]
            }
        }
        delete next.xx
        if(next.en === ""){
            next.en = ' '
        }
        valueObject = next
        value = encodeMultilangString(next)
    }

    // Untagged legacy text becomes the English entry.
    const initial = parseMultilangString(value)
    if(initial.en === undefined){
        initial.en = initial.xx
    }
    commit(initial)
</script>

<div class="flex flex-wrap max-w-fit p-1 gap-2">
    {#each Object.keys(valueObject) as lang}
        {#if lang !== 'xx'}
            <Button size="sm" variant={selectedLang === lang ? 'primary' : 'outline'} className={selectedLang === lang ? '' : 'text-subtext'} aria-pressed={selectedLang === lang} onclick={() => {
                selectedLang = lang
                commit(valueObject)
            }}>{toLangName(lang)}</Button>
        {/if}
    {/each}
</div>
{#if addingLang}
    <div class="m-1 p-1 g-2 flex max-w-fit rounded-md border-t-lightbg flex-wrap gap-1">
        {#each languageCodes as lang}
            {#if toLangName(lang) !== lang}
                <Button size="sm" variant="outline" className="text-subtext" onclick={() => {
                    valueObject = { ...valueObject, [lang]: "" }
                    selectedLang = lang
                    addingLang = false
                }}>{toLangName(lang)}</Button>
            {/if}
        {/each}
    </div>
{/if}
<Textarea autocomplete="off" commitMode="input" value={valueObject[selectedLang]} oncommit={(text) => {
    commit({ ...valueObject, [selectedLang]: text })
    onInput()
}} className={className} />
