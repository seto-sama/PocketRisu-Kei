<script lang="ts">
    import { CheckIcon, SaveIcon, Trash2Icon } from '@lucide/svelte';
    import { onDestroy, tick, untrack } from 'svelte';
    import { DBState, invalidateChatMessageRender } from 'src/ts/stores.svelte';
    import type { Message } from 'src/ts/storage/database.svelte';
    import { language } from 'src/lang';
    import { iconButtonSizeValues } from '../UI/components/IconButton.svelte';
    import Button from '../UI/components/Button.svelte';
    import Badge, { type BadgeVariant } from '../UI/components/Badge.svelte';
    import Dialog from '../UI/components/Dialog.svelte';
    import Textarea from '../UI/components/Textarea.svelte';
    import { isMobile } from 'src/ts/platform';
    import { layerZIndexes } from 'src/ts/gui/layers';
    import { getVisualViewportBounds } from 'src/ts/gui/visualViewport';
    import {
        findAllOriginalRangesFromHtml,
        findAllOriginalRangesFromText,
        replaceRange,
        EDITABLE_BLOCK_SELECTORS,
        type RangeResult,
        type RangeResultWithContext
    } from 'src/ts/parser/partialEdit';
    import type { ChatScrollController } from './chatScroll';

    interface Props {
        screenRoot: HTMLElement | null;
        messages: Message[];
        characterIndex: number;
        chatPage: number;
        chatId?: string | null;
        blockEditEnabled?: boolean;
        dragEditEnabled?: boolean;
        getScrollController?: () => ChatScrollController | null;
    }

    interface PartialEditTarget {
        characterIndex: number;
        chatPage: number;
        chatId: string | null;
        messageIndex: number;
        messageId: string | null;
        messageData: string;
        translatedView: boolean;
        chatRoot: HTMLElement;
        bodyRoot: HTMLElement;
    }

    let {
        screenRoot,
        messages,
        characterIndex,
        chatPage,
        chatId = null,
        blockEditEnabled = false,
        dragEditEnabled = false,
        getScrollController = () => null,
    }: Props = $props();

    const MIN_DRAG_SELECTION_LENGTH = 5;
    const SELECTOR = EDITABLE_BLOCK_SELECTORS.join(', ');
    const PARTIAL_EDIT_ICON_SIZE = iconButtonSizeValues.xs.icon;
    const PARTIAL_EDIT_BUTTON_CELL_SIZE = iconButtonSizeValues.default.cell;
    const PARTIAL_EDIT_BUTTON_GAP = 4;
    const PARTIAL_EDIT_VIEWPORT_GUTTER = 4;
    const HIGH_CONFIDENCE_THRESHOLD = 0.95;
    const MEDIUM_CONFIDENCE_THRESHOLD = 0.7;
    const MATCH_PREVIEW_MAX_LENGTH = 150;

    let isEditing = $state(false);
    let editText = $state('');
    let textareaWrapperRef: HTMLDivElement | null = $state(null);
    let isConfirmingDelete = $state(false);
    let showMatchFailedModal = $state(false);

    type EditAction = 'edit' | 'delete';
    type MatchingMode = EditAction | null;
    type EditSource = 'original' | 'translation';
    let matchingState = $state(emptyMatchingState());
    let matchingRequest: object | null = null;

    let activeTarget: PartialEditTarget | null = null;
    let blockButtonWrapper: HTMLDivElement | null = null;
    let currentHoveredBlock: HTMLElement | null = null;
    let dragButtonWrapper: HTMLDivElement | null = null;
    let currentDragSelectedText = '';
    let rafId: number | null = null;
    let lastMouseX = 0;
    let lastMouseY = 0;
    let selectionTimer: ReturnType<typeof setTimeout> | null = null;
    let focusTimer: ReturnType<typeof setTimeout> | null = null;

    function emptyMatchingState() {
        return {
            mode: null as MatchingMode,
            foundMatches: [] as RangeResultWithContext[],
            selectedRange: null as RangeResult | null,
            sourceType: 'original' as EditSource,
            sourceData: '',
            translationKey: null as string | null,
        };
    }

    function matchConfidenceVariant(confidence: number): BadgeVariant {
        if (confidence >= HIGH_CONFIDENCE_THRESHOLD) return 'success';
        if (confidence >= MEDIUM_CONFIDENCE_THRESHOLD) return 'warning';
        return 'destructive';
    }

    function hasOpenInteraction() {
        return isEditing || isConfirmingDelete || matchingState.mode !== null || showMatchFailedModal;
    }

    function hasTextContent(el: HTMLElement): boolean {
        const clone = el.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('button').forEach(btn => btn.remove());
        return !!clone.textContent?.trim();
    }

    function createButton(
        className: string,
        onAction: (action: EditAction) => void,
        onMouseLeave?: (e: MouseEvent) => void,
    ): HTMLDivElement {
        const wrapper = document.createElement('div');
        wrapper.className = className;
        wrapper.style.setProperty('--partial-edit-icon-size', `${PARTIAL_EDIT_ICON_SIZE}px`);
        wrapper.style.setProperty('--partial-edit-cell-size', `${PARTIAL_EDIT_BUTTON_CELL_SIZE}px`);
        wrapper.style.position = 'fixed';
        wrapper.style.gap = `${PARTIAL_EDIT_BUTTON_GAP}px`;
        wrapper.style.zIndex = layerZIndexes.overlay;
        wrapper.innerHTML = `
            <button type="button" class="partial-edit-btn partial-edit-btn-edit">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                    <path d="m15 5 4 4"/>
                </svg>
            </button>
            <button type="button" class="partial-edit-btn partial-edit-btn-delete">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 6h18"/>
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                    <line x1="10" y1="11" x2="10" y2="17"/>
                    <line x1="14" y1="11" x2="14" y2="17"/>
                </svg>
            </button>
        `;

        const editBtn = wrapper.querySelector('.partial-edit-btn-edit')!;
        editBtn.setAttribute('title', language.partialEdit.editButtonTooltip);
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            onAction('edit');
        });

        const deleteBtn = wrapper.querySelector('.partial-edit-btn-delete')!;
        deleteBtn.setAttribute('title', language.partialEdit.deleteButtonTooltip);
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            onAction('delete');
        });

        if (onMouseLeave) wrapper.addEventListener('mouseleave', onMouseLeave);
        document.body.appendChild(wrapper);
        return wrapper;
    }

    function resolveTarget(element: Element | null): PartialEditTarget | null {
        if (!element || !screenRoot) return null;
        const bodyRoot = element.closest('.chattext') as HTMLElement | null;
        const chatRoot = element.closest('.risu-chat[data-chat-index]') as HTMLElement | null;
        if (!bodyRoot || !chatRoot || !screenRoot.contains(chatRoot) || !chatRoot.contains(bodyRoot)) return null;

        if (chatRoot.dataset.partialEditDisabled === 'true') return null;
        const messageIndex = Number.parseInt(chatRoot.dataset.chatIndex ?? '', 10);
        if (!Number.isInteger(messageIndex) || messageIndex < 0) return null;
        const messageRef = messages[messageIndex];
        if (!messageRef) return null;

        return {
            characterIndex,
            chatPage,
            chatId: chatId ?? null,
            messageIndex,
            messageId: messageRef.chatId ?? null,
            messageData: messageRef.data,
            translatedView: chatRoot.dataset.partialEditTranslated === 'true',
            chatRoot,
            bodyRoot,
        };
    }

    function resolveEditableBlockAtPoint(mouseX: number, mouseY: number) {
        const block = document.elementFromPoint(mouseX, mouseY)?.closest<HTMLElement>(SELECTOR);
        if (!block) return null;

        const target = resolveTarget(block);
        if (!target || block === target.bodyRoot || !hasTextContent(block)) return null;

        return { block, target };
    }

    function getCurrentMessage(target: PartialEditTarget): Message | null {
        const character = DBState.db.characters[target.characterIndex];
        const chat = character?.chats?.[target.chatPage];
        if (!character || !chat) return null;
        if (target.chatId && chat.id !== target.chatId) return null;
        const message = chat.message?.[target.messageIndex];
        if (!message) return null;
        if (target.messageId && message.chatId !== target.messageId) return null;
        return message;
    }

    function validateTarget(target = activeTarget, requireDom = true): target is PartialEditTarget {
        if (!target || target.characterIndex !== characterIndex || target.chatPage !== chatPage) return false;
        if ((target.chatId ?? null) !== (chatId ?? null)) return false;
        const currentMessage = getCurrentMessage(target);
        if (!currentMessage || currentMessage.data !== target.messageData) return false;
        if (requireDom && (!screenRoot || target.chatRoot.dataset.partialEditDisabled === 'true' ||
            (target.chatRoot.dataset.partialEditTranslated === 'true') !== target.translatedView ||
            !target.chatRoot.isConnected || !target.bodyRoot.isConnected ||
            !screenRoot.contains(target.chatRoot) || !target.chatRoot.contains(target.bodyRoot))) return false;
        return true;
    }

    function setActiveTarget(target: PartialEditTarget) {
        matchingRequest = null;
        activeTarget = target;
    }

    function getLastRangeRect(range: Range): DOMRect | null {
        const rects = range.getClientRects();
        for (let i = rects.length - 1; i >= 0; i--) {
            if (rects[i].width || rects[i].height) return rects[i];
        }
        return null;
    }

    function getLastContentRect(block: HTMLElement): DOMRect {
        try {
            const range = document.createRange();
            range.selectNodeContents(block);
            const rect = getLastRangeRect(range);
            if (rect) return rect;
        } catch {
            // Some custom-rendered blocks cannot be represented by a Range.
        }

        const rect = block.getBoundingClientRect();
        return new DOMRect(rect.right, rect.bottom, 0, 0);
    }

    function prepareEditButtons(button: HTMLElement, paddingTop: number) {
        button.style.display = 'flex';
        button.style.paddingLeft = `${PARTIAL_EDIT_BUTTON_GAP}px`;
        button.style.paddingTop = `${paddingTop}px`;

        const width = button.offsetWidth || PARTIAL_EDIT_BUTTON_CELL_SIZE * 2 + PARTIAL_EDIT_BUTTON_GAP * 2;
        const height = button.offsetHeight || PARTIAL_EDIT_BUTTON_CELL_SIZE + paddingTop;
        const viewport = getVisualViewportBounds();
        const minLeft = viewport.left + PARTIAL_EDIT_VIEWPORT_GUTTER;
        const minTop = viewport.top + PARTIAL_EDIT_VIEWPORT_GUTTER;
        const maxLeft = Math.max(minLeft, viewport.right - width - PARTIAL_EDIT_VIEWPORT_GUTTER);
        const maxTop = Math.max(minTop, viewport.bottom - height - PARTIAL_EDIT_VIEWPORT_GUTTER);

        return { width, height, minLeft, minTop, maxLeft, maxTop };
    }

    function applyEditButtonPosition(
        anchor: DOMRect,
        button: HTMLElement,
        left: number,
        top: number,
        layout: ReturnType<typeof prepareEditButtons>,
    ) {
        if (left > layout.maxLeft) left = anchor.right - layout.width;
        if (top > layout.maxTop) top = anchor.top - layout.height;

        button.style.left = `${Math.max(layout.minLeft, Math.min(left, layout.maxLeft))}px`;
        button.style.top = `${Math.max(layout.minTop, Math.min(top, layout.maxTop))}px`;
    }

    function positionBlockButtons(anchor: DOMRect, button: HTMLElement) {
        const layout = prepareEditButtons(button, 0);
        const top = anchor.top + (anchor.height - layout.height) / 2;
        applyEditButtonPosition(anchor, button, anchor.right, top, layout);
    }

    function positionDragButtons(anchor: DOMRect, button: HTMLElement) {
        const layout = prepareEditButtons(button, PARTIAL_EDIT_BUTTON_GAP);
        const left = isMobile
            ? anchor.right - layout.width - PARTIAL_EDIT_BUTTON_GAP
            : anchor.right;
        applyEditButtonPosition(anchor, button, left, anchor.bottom, layout);
    }

    function showBlockButton(block: HTMLElement, target: PartialEditTarget) {
        if (currentHoveredBlock === block && blockButtonWrapper?.style.display === 'flex') return;
        setActiveTarget(target);
        currentHoveredBlock = block;

        if (!blockButtonWrapper) {
            blockButtonWrapper = createButton(
                'partial-edit-btn-wrapper',
                action => findAndProcessMatches(action, currentHoveredBlock),
                (e: MouseEvent) => {
                    const relatedTarget = e.relatedTarget as HTMLElement | null;
                    if (!relatedTarget || !currentHoveredBlock?.contains(relatedTarget)) hideBlockButton();
                },
            );
        }

        positionBlockButtons(getLastContentRect(block), blockButtonWrapper);
    }

    function hideBlockButton() {
        if (blockButtonWrapper) blockButtonWrapper.style.display = 'none';
        currentHoveredBlock = null;
        if (!hasOpenInteraction() && !currentDragSelectedText) activeTarget = null;
    }

    function showDragButton(anchor: DOMRect, target: PartialEditTarget) {
        setActiveTarget(target);
        if (!dragButtonWrapper) {
            dragButtonWrapper = createButton(
                'partial-edit-btn-wrapper partial-edit-drag-btn-wrapper',
                action => findAndProcessMatches(action, currentDragSelectedText),
            );
        }

        positionDragButtons(anchor, dragButtonWrapper);
    }

    function hideDragButton() {
        if (dragButtonWrapper) dragButtonWrapper.style.display = 'none';
        currentDragSelectedText = '';
        if (!hasOpenInteraction() && !currentHoveredBlock) activeTarget = null;
    }

    function clearTimers() {
        if (rafId !== null) cancelAnimationFrame(rafId);
        if (selectionTimer) clearTimeout(selectionTimer);
        if (focusTimer) clearTimeout(focusTimer);
        rafId = null;
        selectionTimer = null;
        focusTimer = null;
    }

    function resetInteraction(removeButtons = false) {
        matchingRequest = null;
        clearTimers();
        hideBlockButton();
        hideDragButton();
        isEditing = false;
        isConfirmingDelete = false;
        showMatchFailedModal = false;
        editText = '';
        matchingState = emptyMatchingState();
        activeTarget = null;
        if (removeButtons) {
            blockButtonWrapper?.remove();
            dragButtonWrapper?.remove();
            blockButtonWrapper = null;
            dragButtonWrapper = null;
        }
    }

    function ensureValidTarget() {
        if (validateTarget()) return true;
        resetInteraction();
        return false;
    }

    async function getTranslationContext(target: PartialEditTarget) {
        let response: Promise<{ key: string; data: string } | null> | null = null;
        target.chatRoot.dispatchEvent(new CustomEvent('risu-partial-edit-translation-context', {
            detail: {
                respond(context: Promise<{ key: string; data: string } | null>) {
                    response = context;
                },
            },
        }));
        return response ? await response : null;
    }

    async function findAndProcessMatches(
        mode: EditAction,
        elementOrText: HTMLElement | string | null,
    ) {
        if (!elementOrText || !ensureValidTarget()) return;
        clearTimers();
        const options = mode === 'edit'
            ? { extendToEOL: false, snapStartToPrevEOL: false }
            : { extendToEOL: true, snapStartToPrevEOL: true };

        const target = activeTarget;
        if (!target) return;
        const request = matchingRequest = {};
        const isTextSelection = typeof elementOrText === 'string';
        const selection = isTextSelection ? elementOrText : elementOrText.outerHTML;
        try {
            const translationContext = target.translatedView
                ? await getTranslationContext(target)
                : null;
            if (matchingRequest !== request || activeTarget !== target) return;
            if (!ensureValidTarget()) return;
            const sourceData = translationContext?.data ?? target.messageData;
            const foundMatches = isTextSelection
                ? findAllOriginalRangesFromText(sourceData, selection, options)
                : findAllOriginalRangesFromHtml(sourceData, selection, options);
            matchingState = {
                ...emptyMatchingState(),
                sourceType: translationContext ? 'translation' : 'original',
                sourceData,
                translationKey: translationContext?.key ?? null,
                foundMatches,
            };

            if (foundMatches.length === 0) {
                showMatchFailedModal = true;
            } else {
                const highConfidenceMatches = foundMatches.filter(
                    match => match.confidence >= HIGH_CONFIDENCE_THRESHOLD,
                );
                const candidates = highConfidenceMatches.length === 1 ? highConfidenceMatches : foundMatches;
                if (candidates.length === 1) selectMatch(candidates[0], mode);
                else matchingState.mode = mode;
            }
            hideBlockButton();
            hideDragButton();
        } catch {
            if (matchingRequest !== request || activeTarget !== target) return;
            resetInteraction();
            showMatchFailedModal = true;
        } finally {
            if (matchingRequest === request) matchingRequest = null;
        }
    }

    function selectMatch(match: RangeResultWithContext, mode: EditAction) {
        if (!ensureValidTarget()) return;
        matchingState.selectedRange = match;
        matchingState.mode = null;
        if (mode === 'edit') {
            editText = matchingState.sourceData.slice(match.start, match.end);
            isEditing = true;
            focusTimer = setTimeout(() => {
                textareaWrapperRef?.querySelector('textarea')?.focus();
            }, 10);
        } else {
            isConfirmingDelete = true;
        }
    }

    function selectMatchAtIndex(index: number) {
        const match = matchingState.foundMatches[index];
        if (match && matchingState.mode) selectMatch(match, matchingState.mode);
    }

    function cancelInteraction() {
        resetInteraction();
    }

    function handlePendingMatchKeydown(e: KeyboardEvent) {
        if (matchingRequest && e.key === 'Escape') {
            e.preventDefault();
            cancelInteraction();
        }
    }

    async function preserveTargetPosition(target: PartialEditTarget, update: () => void) {
        const release = getScrollController()?.preserveElementPosition(target.chatRoot);
        try {
            update();
            await tick();
            await tick();
        } finally {
            release?.();
        }
    }

    function saveNewData(newData: string) {
        if (!ensureValidTarget() || !activeTarget) return;
        const target = activeTarget;
        const message = getCurrentMessage(target);
        if (!message) {
            resetInteraction();
            return;
        }
        const sourceType = matchingState.sourceType;
        const translationKey = matchingState.translationKey;
        void preserveTargetPosition(target, () => {
            resetInteraction();
            if (sourceType === 'translation' && translationKey) {
                target.chatRoot.dispatchEvent(new CustomEvent('risu-partial-edit-translation-save', {
                    detail: { key: translationKey, data: newData },
                }));
                return;
            }
            message.data = newData;
            if (message.swipes && message.swipeId !== undefined) {
                message.swipes[message.swipeId] = newData;
            }
            invalidateChatMessageRender(target.messageIndex);
        });
    }

    function handleSave() {
        if (!matchingState.selectedRange || !ensureValidTarget()) return;
        saveNewData(replaceRange(matchingState.sourceData, matchingState.selectedRange, editText));
    }

    function handleConfirmDelete() {
        if (!matchingState.selectedRange || !ensureValidTarget()) return;
        let newData = replaceRange(matchingState.sourceData, matchingState.selectedRange, '');
        newData = newData.replace(/\n{3,}/g, '\n\n').trim();
        saveNewData(newData);
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            e.preventDefault();
            cancelInteraction();
        }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSave();
    }

    function attachPartialEditTextarea(node: HTMLDivElement) {
        textareaWrapperRef = node;
        node.addEventListener('keydown', handleKeydown);
        return {
            destroy() {
                node.removeEventListener('keydown', handleKeydown);
                if (textareaWrapperRef === node) textareaWrapperRef = null;
            },
        };
    }

    function isMouseOnBlockButton(mouseX: number, mouseY: number): boolean {
        if (!blockButtonWrapper || blockButtonWrapper.style.display === 'none') return false;
        const rect = blockButtonWrapper.getBoundingClientRect();
        return mouseX >= rect.left && mouseX <= rect.right && mouseY >= rect.top && mouseY <= rect.bottom;
    }

    function updateBlockHover(mouseX: number, mouseY: number) {
        if (isMouseOnBlockButton(mouseX, mouseY)) return;

        const resolved = resolveEditableBlockAtPoint(mouseX, mouseY);
        if (!resolved) {
            hideBlockButton();
            return;
        }

        showBlockButton(resolved.block, resolved.target);
    }

    function handleMove(e: MouseEvent) {
        if (!blockEditEnabled || isEditing || isConfirmingDelete || matchingState.mode) return;
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) {
            hideBlockButton();
            return;
        }

        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        if (rafId !== null) return;

        rafId = requestAnimationFrame(() => {
            rafId = null;
            updateBlockHover(lastMouseX, lastMouseY);
        });
    }

    function handleSelectionChange() {
        if (!dragEditEnabled || isEditing || isConfirmingDelete || matchingState.mode) return;
        if (selectionTimer) clearTimeout(selectionTimer);
        selectionTimer = setTimeout(() => {
            selectionTimer = null;
            const selection = window.getSelection();
            if (!selection || selection.isCollapsed || !selection.toString().trim() || selection.rangeCount === 0) {
                hideDragButton();
                return;
            }
            const range = selection.getRangeAt(0);
            const ancestor = range.commonAncestorContainer;
            const ancestorEl = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor as HTMLElement : ancestor.parentElement;
            const startEl = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as HTMLElement : range.startContainer.parentElement;
            const endEl = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer as HTMLElement : range.endContainer.parentElement;
            const target = resolveTarget(ancestorEl);
            if (!target || !startEl || !endEl || !target.bodyRoot.contains(startEl) || !target.bodyRoot.contains(endEl)) {
                hideDragButton();
                return;
            }
            const rect = range.getBoundingClientRect();
            const selectedText = selection.toString();
            if ((rect.width === 0 && rect.height === 0) || selectedText.length < MIN_DRAG_SELECTION_LENGTH) {
                hideDragButton();
                return;
            }
            currentDragSelectedText = selectedText;
            showDragButton(getLastRangeRect(range) ?? rect, target);
        }, 150);
    }

    function handleMouseDown(e: MouseEvent) {
        if (!dragEditEnabled || hasOpenInteraction()) return;
        if (dragButtonWrapper?.contains(e.target as Node)) return;
        hideDragButton();
    }

    function handleScroll() {
        if (hasOpenInteraction()) return;
        hideBlockButton();
        hideDragButton();
    }

    function handleScreenLeave(e: MouseEvent) {
        if (hasOpenInteraction()) return;
        const relatedTarget = e.relatedTarget as HTMLElement | null;
        if (relatedTarget && blockButtonWrapper?.contains(relatedTarget)) return;
        hideBlockButton();
    }

    $effect(() => {
        if (!screenRoot) return;
        document.addEventListener('keydown', handlePendingMatchKeydown);
        if (blockEditEnabled) document.addEventListener('mousemove', handleMove);
        if (dragEditEnabled) {
            document.addEventListener('selectionchange', handleSelectionChange);
            document.addEventListener('mousedown', handleMouseDown);
        }
        document.addEventListener('scroll', handleScroll, true);
        window.visualViewport?.addEventListener('resize', handleScroll);
        window.visualViewport?.addEventListener('scroll', handleScroll);
        screenRoot.addEventListener('mouseleave', handleScreenLeave);
        return () => {
            document.removeEventListener('keydown', handlePendingMatchKeydown);
            document.removeEventListener('mousemove', handleMove);
            document.removeEventListener('selectionchange', handleSelectionChange);
            document.removeEventListener('mousedown', handleMouseDown);
            document.removeEventListener('scroll', handleScroll, true);
            window.visualViewport?.removeEventListener('resize', handleScroll);
            window.visualViewport?.removeEventListener('scroll', handleScroll);
            screenRoot.removeEventListener('mouseleave', handleScreenLeave);
            resetInteraction(true);
        };
    });

    $effect(() => {
        const identity = `${characterIndex}:${chatPage}:${chatId ?? ''}`;
        void identity;
        untrack(() => resetInteraction());
    });

    $effect(() => {
        if (!screenRoot) return;
        const observer = new MutationObserver(() => {
            if (activeTarget && !validateTarget(activeTarget)) resetInteraction();
        });
        observer.observe(screenRoot, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-partial-edit-disabled', 'data-partial-edit-translated'],
        });
        return () => observer.disconnect();
    });

    onDestroy(() => resetInteraction(true));
</script>

{#snippet MatchConfidenceBadge(match: RangeResult | null, className = '')}
    {#if match}
        <Badge size="sm" variant={matchConfidenceVariant(match.confidence)} {className}>
            {language.partialEdit.matchConfidence(Math.round(match.confidence * 100))}
        </Badge>
    {/if}
{/snippet}

{#snippet MatchSelectionModal(matches: RangeResultWithContext[], dialogTitle: string)}
    <Dialog
        open={true}
        size="lg"
        closable={false}
        onRequestClose={cancelInteraction}
        contentClass="overflow-hidden"
        bodyClass="min-h-0 overflow-y-auto"
    >
        {#snippet title()}{dialogTitle}{/snippet}
        {#snippet headerActions()}
            <Badge variant="secondary">{matches.length} {language.partialEdit.matchesFound}</Badge>
        {/snippet}

        <div class="match-list">
            {#each matches as match, i}
                {@const matchedText = matchingState.sourceData.slice(match.start, match.end)}
                <button type="button" class="match-item" onclick={() => selectMatchAtIndex(i)}>
                    <div class="match-meta">
                        <span class="text-sm text-subtext">
                            {language.partialEdit.lineNumber(match.lineNumber)}
                        </span>
                        {@render MatchConfidenceBadge(match, 'ml-auto')}
                    </div>
                    <div class="match-preview">{#if match.contextBefore}<span>{match.contextBefore} </span>{/if}<mark class="match-highlight">{matchedText.slice(0, MATCH_PREVIEW_MAX_LENGTH)}</mark>{matchedText.length > MATCH_PREVIEW_MAX_LENGTH ? '...' : ''}{#if match.contextAfter}<span> {match.contextAfter}</span>{/if}</div>
                </button>
            {/each}
        </div>

        {#snippet footer()}
            <Button variant="outline" onclick={cancelInteraction}>
                {language.cancel}
            </Button>
        {/snippet}
    </Dialog>
{/snippet}

{#if showMatchFailedModal}
    <Dialog open={true} closable={false} onRequestClose={cancelInteraction}>
        {#snippet title()}{language.partialEdit.matchFailedTitle}{/snippet}
        {#snippet description()}{language.partialEdit.matchFailedMessage}{/snippet}
        {#snippet footer()}
            <Button variant="primary" size="sm" onclick={cancelInteraction}>
                <CheckIcon size={12} />
                <span>{language.confirm}</span>
            </Button>
        {/snippet}
    </Dialog>
{/if}

{#if isConfirmingDelete}
    <Dialog open={true} closable={false} onRequestClose={cancelInteraction} contentClass="gap-3">
        {#snippet title()}{language.partialEdit.deleteModalTitle}{/snippet}
        {#snippet description()}{language.partialEdit.deleteConfirmMessage}{/snippet}
        {#snippet headerActions()}
            {@render MatchConfidenceBadge(matchingState.selectedRange)}
        {/snippet}
        {#if matchingState.selectedRange}
            {@const matchedText = matchingState.sourceData.slice(matchingState.selectedRange.start, matchingState.selectedRange.end)}
            <div class="partial-delete-preview">
                {matchedText.slice(0, 200)}{matchedText.length > 200 ? '...' : ''}
            </div>
        {/if}
        {#snippet footer()}
            <Button variant="outline" size="sm" onclick={cancelInteraction}>
                <span>{language.partialEdit.deleteNo}</span>
            </Button>
            <Button variant="destructive" size="sm" onclick={handleConfirmDelete}>
                <Trash2Icon size={12} />
                <span>{language.partialEdit.deleteYes}</span>
            </Button>
        {/snippet}
    </Dialog>
{/if}

{#if matchingState.mode}
    {@render MatchSelectionModal(matchingState.foundMatches, matchingState.mode === 'edit' ? language.partialEdit.selectMatch : language.partialEdit.selectDeleteMatch)}
{/if}

{#if isEditing}
    <Dialog
        open={true}
        size="default"
        closable={false}
        onRequestClose={cancelInteraction}
        contentClass="gap-3"
    >
        {#snippet title()}{language.partialEdit.editModalTitle}{/snippet}
        {#snippet headerActions()}
            {@render MatchConfidenceBadge(matchingState.selectedRange)}
        {/snippet}
        <div use:attachPartialEditTextarea>
            <Textarea
                bind:value={editText}
                fullwidth
                size="sm"
                actionBar={false}
                commitMode="input"
            />
        </div>
        {#snippet footer()}
            <Button
                variant="outline"
                size="sm"
                onclick={cancelInteraction}
                title={language.partialEdit.cancelShortcut}
            >
                <span>{language.partialEdit.cancel}</span>
            </Button>
            <Button
                variant="primary"
                size="sm"
                className="partial-edit-save-btn"
                onclick={handleSave}
                title={language.partialEdit.saveShortcut}
            >
                <SaveIcon />
                <span>{language.partialEdit.save}</span>
            </Button>
        {/snippet}
    </Dialog>
{/if}

<style>
    :global(.partial-edit-btn-wrapper) {
        display: none;
    }

    :global(.partial-edit-btn) {
        display: flex;
        align-items: center;
        justify-content: center;
        width: var(--partial-edit-cell-size);
        height: var(--partial-edit-cell-size);
        padding: 0;
        background: var(--risu-theme-maintext);
        border: 1px solid var(--risu-theme-maintext);
        border-radius: 6px;
        cursor: pointer;
        box-shadow: 0 2px 8px color-mix(in srgb, var(--risu-theme-maintext) 15%, transparent);
        transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
        color: var(--risu-theme-lightbg);
    }

    :global(.partial-edit-btn svg) {
        width: var(--partial-edit-icon-size);
        height: var(--partial-edit-icon-size);
    }

    :global(.partial-edit-btn-edit:is(:hover, :focus-visible)) {
        background: color-mix(in srgb, var(--risu-theme-primary) 15%, var(--risu-theme-maintext));
        border-color: var(--risu-theme-primary);
        color: var(--risu-theme-primary);
    }

    :global(.partial-edit-btn-delete:is(:hover, :focus-visible)) {
        background: color-mix(in srgb, var(--risu-theme-danger) 15%, var(--risu-theme-maintext));
        border-color: var(--risu-theme-danger);
        color: var(--risu-theme-danger);
    }

    .partial-delete-preview {
        padding: 12px;
        background: color-mix(in srgb, var(--risu-theme-darkbg) 60%, transparent);
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: 8px;
        font-size: 13px;
        color: var(--risu-theme-maintext);
        max-height: 100px;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .match-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
    }

    .match-item {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 16px;
        width: 100%;
        text-align: left;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: 12px;
        background: var(--risu-theme-lightbg);
        color: var(--risu-theme-maintext);
        cursor: pointer;
        transition: background-color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
    }

    .match-item:is(:hover, :focus-visible) {
        background: color-mix(in srgb, var(--risu-theme-selected) 30%, var(--risu-theme-lightbg));
        border-color: var(--risu-theme-lightborderc);
        box-shadow: 0 2px 8px color-mix(in srgb, var(--risu-theme-primary) 20%, transparent);
        outline: none;
    }

    .match-meta {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }

    .match-preview {
        padding-top: 8px;
        border-top: 1px solid var(--risu-theme-darkborderc);
        font-family: monospace;
        font-size: 14px;
        color: var(--risu-theme-maintext);
        line-height: 1.25rem;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
    }

    .match-highlight {
        padding: 0 2px;
        border-radius: 2px;
        background: color-mix(in srgb, var(--risu-theme-primary) 15%, transparent);
        color: var(--risu-theme-primary);
        font-weight: 500;
    }
</style>
