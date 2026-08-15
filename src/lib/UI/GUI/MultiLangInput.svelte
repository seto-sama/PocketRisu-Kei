<script lang="ts">
    import { encodeMultilangString, languageCodes, parseMultilangString, toLangName } from "src/ts/util";
    import ShButton from "./ShButton.svelte";
    import TextAreaInput from "./TextAreaInput.svelte";
    let selectedLang = $state("en")
    interface Props {
        value: string;
        addingLang?: boolean;
        className?: string;
        onInput?: any;
    }

    let { value = $bindable(), addingLang = $bindable(false), className = "", onInput = () => {} }: Props = $props();
    let parsed = parseMultilangString(value)
    if(parsed["en"] === undefined){
        parsed["en"] = parsed["xx"]
        delete parsed["xx"]
    }
    let valueObject: {[code:string]:string} = $state(parsed)
    const updateValue = () => {
        for(let lang in valueObject){
            if(valueObject[lang] === "" && lang !== selectedLang && lang!=="en" ){
                delete valueObject[lang]
            }
        }
        if(valueObject.xx){
            delete valueObject.xx
        }
        if(valueObject.en === ""){
            valueObject.en = ' '
        }
        valueObject = valueObject // force update
        value = encodeMultilangString(valueObject)
    }
    updateValue()
    $effect.pre(() => {
        valueObject = parseMultilangString(value)
    });
</script>

<div class="flex flex-wrap max-w-fit p-1 gap-2">
    {#each Object.keys(valueObject) as lang}
        {#if lang !== 'xx'}
            <ShButton size="sm" variant={selectedLang === lang ? 'primary' : 'outline'} className={selectedLang === lang ? '' : 'text-textcolor2'} aria-pressed={selectedLang === lang} onclick={() => {
                selectedLang = lang
                updateValue()
            }}>{toLangName(lang)}</ShButton>
        {/if}
    {/each}
</div>
{#if addingLang}
    <div class="m-1 p-1 g-2 flex max-w-fit rounded-md border-t-bgcolor flex-wrap gap-1">
        {#each languageCodes as lang}
            {#if toLangName(lang) !== lang}
                <ShButton size="sm" variant="outline" className="text-textcolor2" onclick={() => {
                    valueObject[lang] = ""
                    selectedLang = lang
                    addingLang = false
                }}>{toLangName(lang)}</ShButton>
            {/if}
        {/each}
    </div>
{/if}
<TextAreaInput autocomplete="off" bind:value={valueObject[selectedLang]} onInput={() => {
    updateValue()
    onInput()
}} className={className} />
