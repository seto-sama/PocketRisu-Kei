<script lang="ts">
    import { CompassIcon } from '@lucide/svelte'
    import { tick, untrack } from 'svelte'
    import { language } from 'src/lang'
    import Badge from '../UI/components/Badge.svelte'
    import Button from '../UI/components/Button.svelte'
    import ChoiceGroup from '../UI/components/ChoiceGroup.svelte'
    import Dialog from '../UI/components/Dialog.svelte'
    import EmptyState from '../UI/components/EmptyState.svelte'
    import Input from '../UI/components/Input.svelte'
    import { alertError } from 'src/ts/alert'
    import type { character as Character, Chat, OnboardingQuestion } from 'src/ts/storage/database.svelte'
    import type { ChatWorkingCopyTarget } from 'src/ts/storage/chatWorkingCopy'
    import {
        applyOnboardingAnswers,
        getActiveOnboarding,
        getOptionValue,
        isQuestionAnswered,
        onboardingVarNameAttr,
        onboardingVarValueAttr,
        parseMultipleValue,
        readFormAnswers,
        readOnboardingVar,
        stringifyMultipleValue,
    } from 'src/ts/onboarding'
    import { parseOnboardingHTML } from 'src/ts/parser/parser.svelte'

    interface Props {
        open?: boolean
        character: Character
        /** The chat that receives the answers. Without it, the creator's draft is previewed. */
        chat?: Chat
    }

    let { open = $bindable(false), character, chat }: Props = $props()

    const preview = $derived(!chat)
    const onboarding = $derived(preview ? character.onboarding : getActiveOnboarding(character))
    const questions = $derived(onboarding?.questions?.filter((q) => q.varName) ?? [])

    // Answers are staged here and only written on Done, so Skip and dismissing leave the variables untouched.
    let answers: Record<string, string> = $state({})
    let renderedHTML = $state('')
    let htmlContainer: HTMLDivElement | undefined = $state()
    let showRequiredError = $state(false)
    let submitting = $state(false)
    // Captured on open so switching chats cannot redirect the answers.
    let target: ChatWorkingCopyTarget | null = null
    const htmlBindings = new Map<string, HTMLElement[]>()

    const missingRequired = $derived(
        onboarding?.mode === 'form' && questions.some((q) => q.required && !isQuestionAnswered(q, answers))
    )

    $effect(() => {
        if(!open){
            return
        }
        let cancelled = false
        untrack(() => {
            target = chat?.id ? { characterId: character.chaId, chatId: chat.id } : null
            answers = chat ? readFormAnswers(character, chat, questions) : {}
            showRequiredError = false
            renderedHTML = ''
            if(onboarding?.mode === 'html'){
                renderHTML(onboarding.html ?? '', () => cancelled)
            }
        })
        return () => {
            cancelled = true
            htmlBindings.clear()
        }
    })

    async function renderHTML(html: string, isCancelled: () => boolean){
        const rendered = await parseOnboardingHTML(html, character)
        if(isCancelled()){
            return
        }
        renderedHTML = rendered
        await tick()
        if(isCancelled()){
            return
        }
        for(const el of htmlContainer?.querySelectorAll<HTMLElement>(`[${onboardingVarNameAttr}]`) ?? []){
            const varName = el.getAttribute(onboardingVarNameAttr)
            const elements = htmlBindings.get(varName)
            if(elements){
                elements.push(el)
            }
            else{
                htmlBindings.set(varName, [el])
            }
        }
        for(const varName of htmlBindings.keys()){
            syncHTMLState(true, varName)
        }
    }

    function choiceOptions(question: OnboardingQuestion){
        const seen = new Set<string>()
        return question.options.flatMap((option) => {
            const value = getOptionValue(option)
            if(!value || seen.has(value)){
                return []
            }
            seen.add(value)
            return [{ value, label: option.label || value }]
        })
    }

    function isFormControl(el: Element): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
        return el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
    }

    function getStagedValue(varName: string): string | undefined {
        if(varName in answers){
            return answers[varName]
        }
        return chat ? readOnboardingVar(character, chat, varName) : undefined
    }

    // Inputs are filled on open; subsequent edits only update the matching choices.
    function syncHTMLState(fillInputs: boolean, varName: string){
        const current = getStagedValue(varName)
        for(const el of htmlBindings.get(varName) ?? []){
            if(isFormControl(el)){
                if(!fillInputs || current === undefined){
                    continue
                }
                if(el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')){
                    const onValue = el.getAttribute(onboardingVarValueAttr) ?? (el.type === 'checkbox' ? '1' : el.value)
                    el.checked = current === onValue
                }
                else{
                    el.value = current
                }
                continue
            }
            const selected = current !== undefined && current === (el.getAttribute(onboardingVarValueAttr) ?? '')
            el.classList.toggle('x-risu-selected', selected)
        }
    }

    function onHTMLClick(e: MouseEvent){
        const target = (e.target as Element)?.closest?.(`[${onboardingVarNameAttr}]`)
        if(!target || !htmlContainer?.contains(target) || isFormControl(target)){
            return
        }
        e.preventDefault()
        const varName = target.getAttribute(onboardingVarNameAttr)
        answers[varName] = target.getAttribute(onboardingVarValueAttr) ?? ''
        syncHTMLState(false, varName)
    }

    function onHTMLInput(e: Event){
        const target = e.target as Element
        if(!isFormControl(target) || !target.hasAttribute(onboardingVarNameAttr)){
            return
        }
        const varName = target.getAttribute(onboardingVarNameAttr)
        const fixedValue = target.getAttribute(onboardingVarValueAttr)
        if(target instanceof HTMLInputElement && target.type === 'checkbox'){
            answers[varName] = target.checked ? (fixedValue ?? '1') : '0'
        }
        else if(target instanceof HTMLInputElement && target.type === 'radio'){
            if(target.checked){
                answers[varName] = fixedValue ?? target.value
            }
        }
        else{
            answers[varName] = target.value
        }
        syncHTMLState(false, varName)
    }

    async function complete(staged: Record<string, string>){
        submitting = true
        try {
            if(target){
                await applyOnboardingAnswers(target, staged)
            }
            open = false
        } catch (error) {
            alertError(error)
        } finally {
            submitting = false
        }
    }

    function finish(){
        if(missingRequired){
            showRequiredError = true
            return
        }
        return complete($state.snapshot(answers))
    }
</script>

<Dialog bind:open size="lg" closable>
    {#snippet title()}
        <span class="flex min-w-0 items-center gap-2">
            <CompassIcon class="size-5 shrink-0" />
            <span class="truncate">{onboarding?.title || character.name || language.onboarding}</span>
            {#if preview}
                <Badge variant="secondary" size="sm">{language.preview}</Badge>
            {/if}
        </span>
    {/snippet}

    <div class="flex flex-col gap-5 break-any">
        {#if !onboarding}
            <EmptyState title={language.noData} layout="section" density="compact" />
        {:else if onboarding.mode === 'html'}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="chattext prose max-w-full wrap-break-word risu-rich-text text-maintext"
                bind:this={htmlContainer}
                onclick={onHTMLClick}
                oninput={onHTMLInput}
                onchange={onHTMLInput}
                onsubmit={(e) => e.preventDefault()}
            >
                {@html renderedHTML}
            </div>
        {:else}
            {#if onboarding.description}
                <p class="text-sm text-subtext whitespace-pre-wrap">{onboarding.description}</p>
            {/if}
            {#each questions as question (question.id)}
                <section class="flex flex-col gap-2">
                    <div>
                        <h3 class="text-sm font-semibold text-maintext">
                            {question.title || question.varName}
                            {#if question.required}
                                <span class="text-danger">*</span>
                            {/if}
                        </h3>
                        {#if question.description}
                            <p class="mt-0.5 text-xs text-subtext whitespace-pre-wrap">{question.description}</p>
                        {/if}
                    </div>
                    {#if question.type === 'text'}
                        <Input
                            size="sm"
                            placeholder={question.placeholder ?? ''}
                            value={answers[question.varName] ?? ''}
                            oninput={(e) => { answers[question.varName] = (e.currentTarget as HTMLInputElement).value }}
                        />
                    {:else if question.type === 'multiple'}
                        <ChoiceGroup
                            mode="multiple"
                            options={choiceOptions(question)}
                            values={parseMultipleValue(answers[question.varName])}
                            onValuesChange={(values) => { answers[question.varName] = stringifyMultipleValue(values) }}
                        />
                    {:else}
                        <ChoiceGroup
                            options={choiceOptions(question)}
                            value={answers[question.varName] ?? ''}
                            onValueChange={(value) => { answers[question.varName] = value }}
                        />
                    {/if}
                    {#if showRequiredError && question.required && !isQuestionAnswered(question, answers)}
                        <span class="text-xs text-danger">{language.onboardingRequiredMissing}</span>
                    {/if}
                </section>
            {/each}
        {/if}
    </div>

    {#snippet footer()}
        <Button variant="outline" disabled={submitting} onclick={() => complete({})}>{language.onboardingSkip}</Button>
        <Button variant="primary" disabled={submitting} onclick={finish}>{language.onboardingDone}</Button>
    {/snippet}
</Dialog>
