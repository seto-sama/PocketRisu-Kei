<script lang="ts">
    import { EyeIcon, GripVerticalIcon, PlusIcon, TrashIcon, XIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Help from '../Others/Help.svelte'
    import OnboardingDialog from '../Others/OnboardingDialog.svelte'
    import Button from '../UI/components/Button.svelte'
    import ChoiceGroup from '../UI/components/ChoiceGroup.svelte'
    import IconButton from '../UI/components/IconButton.svelte'
    import Input from '../UI/components/Input.svelte'
    import Select from '../UI/components/Select.svelte'
    import SelectOption from '../UI/components/SelectOption.svelte'
    import SortableList from '../UI/components/SortableList.svelte'
    import Switch from '../UI/components/Switch.svelte'
    import Textarea from '../UI/components/Textarea.svelte'
    import type { character as Character } from 'src/ts/storage/database.svelte'
    import { createOnboarding, createOnboardingQuestion } from 'src/ts/onboarding'

    interface Props {
        character: Character
    }

    let { character }: Props = $props()
    let previewOpen = $state(false)

    const modeOptions = [
        { value: 'form', label: language.onboardingModeForm },
        { value: 'html', label: language.onboardingModeHTML },
    ]

    function setEnabled(enabled: boolean){
        if(enabled && !character.onboarding){
            character.onboarding = createOnboarding()
            return
        }
        if(character.onboarding){
            character.onboarding.enabled = enabled
        }
    }

    function reorderQuestions(orderedIds: string[]){
        const questionsById = new Map(character.onboarding.questions.map((question) => [question.id, question]))
        character.onboarding.questions = orderedIds
            .map((id) => questionsById.get(id))
            .filter((question) => !!question)
    }
</script>

<div class="mt-4 flex items-center justify-between gap-3">
    <span class="min-w-0 text-maintext">{language.onboarding}<Help key="onboarding" name={language.onboarding} /></span>
    <Switch checked={!!character.onboarding?.enabled} ariaLabel={language.onboardingEnable} onCheckedChange={setEnabled} />
</div>

{#if character.onboarding?.enabled}
    <div class="mt-2 flex flex-col gap-2 rounded-md border border-darkborderc p-3">
        <div class="flex flex-wrap items-center gap-2">
            <ChoiceGroup variant="segment" size="md" bind:value={character.onboarding.mode} options={modeOptions} />
            <div class="flex-1"></div>
            <Button size="sm" variant="outline" onclick={() => { previewOpen = true }}>
                <EyeIcon />{language.preview}
            </Button>
        </div>

        <div class="flex items-center justify-between gap-3">
            <span class="min-w-0 text-sm text-maintext">{language.onboardingFloatingButton}</span>
            <Switch size="sm" bind:checked={character.onboarding.floatingButton} ariaLabel={language.onboardingFloatingButton} />
        </div>

        <span class="text-sm text-subtext">{language.onboardingTitle}</span>
        <Input size="sm" bind:value={character.onboarding.title} placeholder={character.name} />

        {#if character.onboarding.mode === 'html'}
            <span class="text-sm text-subtext">HTML</span>
            <Textarea margin="none" autocomplete="off" bind:value={character.onboarding.html} placeholder={'<button risu-change-var-name="route" risu-change-var-value="a">A</button>'} />
            <span class="text-xs text-subtext">{language.onboardingHTMLHint}</span>
        {:else}
            <span class="text-sm text-subtext">{language.description}</span>
            <Textarea margin="none" autocomplete="off" bind:value={character.onboarding.description} />

            <SortableList className="flex flex-col gap-2" handle="[data-onboarding-question-handle]" onReorder={reorderQuestions}>
                {#each character.onboarding.questions as question, i (question.id)}
                    <div data-sortable-key={question.id} class="flex flex-col gap-2 rounded-md border border-darkborderc bg-darkbg p-3">
                        <div class="flex items-center gap-2">
                            <span data-onboarding-question-handle class="cursor-grab text-subtext" aria-hidden="true">
                                <GripVerticalIcon class="size-4" />
                            </span>
                            <span class="text-xs font-medium uppercase tracking-wider text-subtext">{language.onboardingQuestion} {i + 1}</span>
                            <div class="flex-1"></div>
                            <IconButton size="sm" tone="destructive" title={language.remove} aria-label={language.remove} onclick={() => { character.onboarding.questions.splice(i, 1) }}>
                                <TrashIcon />
                            </IconButton>
                        </div>

                        <Input size="sm" bind:value={question.title} placeholder={language.onboardingQuestion} />
                        <Input size="sm" bind:value={question.description} placeholder={language.description} />

                        <div class="flex flex-wrap gap-2">
                            <div class="flex min-w-32 flex-1 flex-col">
                                <span class="mb-1 text-xs text-subtext">{language.onboardingVarName}</span>
                                <Input size="sm" bind:value={question.varName} placeholder="varname" />
                            </div>
                            <div class="flex min-w-32 flex-1 flex-col">
                                <span class="mb-1 text-xs text-subtext">{language.type}</span>
                                <Select size="sm" bind:value={question.type}>
                                    <SelectOption value="single">{language.onboardingTypeSingle}</SelectOption>
                                    <SelectOption value="multiple">{language.onboardingTypeMultiple}</SelectOption>
                                    <SelectOption value="text">{language.onboardingTypeText}</SelectOption>
                                </Select>
                            </div>
                        </div>
                        {#if !question.varName}
                            <span class="text-xs text-danger">{language.onboardingVarNameMissing}</span>
                        {/if}

                        {#if question.type === 'text'}
                            <Input size="sm" bind:value={question.placeholder} placeholder={language.onboardingPlaceholder} />
                        {:else}
                            <div class="flex flex-col gap-1.5">
                                {#each question.options as option, j}
                                    <div class="flex items-center gap-2">
                                        <Input size="sm" className="min-w-0 flex-1" bind:value={option.label} placeholder={language.onboardingOptionLabel} />
                                        <Input size="sm" className="min-w-0 flex-1" bind:value={option.value} placeholder={option.label || language.onboardingOptionValue} />
                                        <IconButton size="sm" tone="destructive" title={language.remove} aria-label={language.remove} onclick={() => { question.options.splice(j, 1) }}>
                                            <XIcon />
                                        </IconButton>
                                    </div>
                                {/each}
                                <Button size="sm" variant="ghost" className="self-start" onclick={() => { question.options.push({ label: '', value: '' }) }}>
                                    <PlusIcon />{language.onboardingAddOption}
                                </Button>
                            </div>
                        {/if}

                        <div class="flex items-center justify-between gap-3">
                            <span class="min-w-0 text-sm text-maintext">{language.onboardingRequired}</span>
                            <Switch size="sm" bind:checked={question.required} ariaLabel={language.onboardingRequired} />
                        </div>
                    </div>
                {/each}
            </SortableList>

            <Button variant="outline" className="w-full border-dashed" onclick={() => { character.onboarding.questions.push(createOnboardingQuestion()) }}>
                <PlusIcon />{language.onboardingAddQuestion}
            </Button>
        {/if}
    </div>
{/if}

<OnboardingDialog bind:open={previewOpen} {character} />
