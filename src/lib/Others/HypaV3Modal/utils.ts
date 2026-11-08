import { get } from "svelte/store";
import { getChatPage } from 'src/ts/storage/chatSelection.svelte';

import { parseChatDisplayMessage, processScriptFull, risuChatParser } from "src/ts/process/scripts";
import { type Message } from "src/ts/storage/database.svelte";
import { alertConfirm } from "src/ts/alert";
import { DBState, selectedCharID } from "src/ts/stores.svelte";
import { translateHTML } from "src/ts/translator/translator";
import { maskUntranslatable } from "src/ts/translator/translationMask";
import { getUserName } from "src/ts/util";
import { language } from "src/lang";
import type { Category } from "./types";
import {
  getCurrentHypaV3Preset,
  type SerializableHypaV3Data,
  type SerializableSummary,
} from "src/ts/process/memory/hypav3";

export async function alertConfirmTwice(
  firstMessage: string,
  secondMessage: string
): Promise<boolean> {
  return (
    (await alertConfirm(firstMessage)) && (await alertConfirm(secondMessage))
  );
}

export type DualActionParams = {
  onMainAction?: () => void;
  onAlternativeAction?: () => void;
};

export function handleDualAction(
  element: HTMLElement,
  params: DualActionParams = {}
) {
  const DOUBLE_TAP_DELAY = 300;
  const isTouch = "ontouchend" in window;
  let lastTap = 0;
  let tapTimeout: number | undefined;

  const handleTouch = (event: TouchEvent) => {
    const now = Date.now();
    const sinceLastTap = now - lastTap;

    if (sinceLastTap > 0 && sinceLastTap < DOUBLE_TAP_DELAY) {
      event.preventDefault();
      window.clearTimeout(tapTimeout);
      lastTap = 0;
      params.onAlternativeAction?.();
      return;
    }
    lastTap = now;
    // Defer the main action so a second tap can trigger the alternative.
    tapTimeout = window.setTimeout(() => {
      if (lastTap === now) params.onMainAction?.();
    }, DOUBLE_TAP_DELAY);
  };

  const handleClick = (event: MouseEvent) => {
    (event.shiftKey ? params.onAlternativeAction : params.onMainAction)?.();
  };

  if (isTouch) element.addEventListener("touchend", handleTouch);
  else element.addEventListener("click", handleClick);

  return {
    destroy() {
      if (isTouch) element.removeEventListener("touchend", handleTouch);
      else element.removeEventListener("click", handleClick);
      window.clearTimeout(tapTimeout);
    },
    update(newParams: DualActionParams) {
      params = newParams;
    },
  };
}

export function getFirstMessage(): string | null {
  const char = DBState.db.characters[get(selectedCharID)];
  const fmIndex = char.chats[getChatPage(char)].fmIndex ?? -1;

  return (fmIndex === -1 ? char.firstMessage : char.alternateGreetings?.[fmIndex]) || null;
}

// Messages are addressed by chat index; -1 is the greeting.
export function processMessageCBS(msg: Message, msgIndex: number): Message {
  return {
    ...msg,
    data: risuChatParser(msg.data, {
      chara: DBState.db.characters[get(selectedCharID)],
      chatID: msgIndex,
      role: msg.role,
      rmVar: true,
      cbsConditions: { chatRole: msg.role, firstmsg: msgIndex === -1 },
    }),
  };
}

// Raw-text LLM translation keys on the chat's display text with translate="no"
// masking, so this shares the chat's cache. Otherwise the chat key is rendered
// HTML, and fallbackText is translated as is.
export async function translateChatMessage(
  msg: Message,
  msgIndex: number,
  fallbackText: string,
  regenerate: boolean
): Promise<string> {
  if (DBState.db.translatorType !== "llm" || !DBState.db.translateBeforeHTMLFormatting) {
    return await translateHTML(fallbackText, false, "", -1, regenerate);
  }
  const char = DBState.db.characters[get(selectedCharID)];
  const masked = maskUntranslatable(parseChatDisplayMessage(msg.data, {
    name: msg.role === "user" ? getUserName() : char.name,
    chatID: msgIndex,
    cbsConditions: { firstmsg: msgIndex === -1, chatRole: msg.role },
  }));
  return masked.restore(await translateHTML(masked.source, false, "", -1, regenerate));
}

export async function processHypaV3Message(
  msg: Message,
  msgIndex: number,
  applyRegexScript: boolean
): Promise<Message> {
  const processed = processMessageCBS(msg, msgIndex);
  if (!applyRegexScript) return processed;

  const char = DBState.db.characters[get(selectedCharID)];
  const { data } = await processScriptFull(char, processed.data, "editprocess", msgIndex, {
    chatRole: msg.role,
  });
  return { ...msg, data };
}

export async function getNextSummarizationTarget(
  hypaV3Data: SerializableHypaV3Data
): Promise<Message | null> {
  const char = DBState.db.characters[get(selectedCharID)];
  const chat = char.chats[getChatPage(char)];
  const shouldProcess = getCurrentHypaV3Preset().settings.processRegexScript;

  const lastChatMemo = hypaV3Data.summaries.at(-1)?.chatMemos.at(-1);
  const lastIndex = lastChatMemo == null
    ? -1
    : chat.message.findIndex((message) => message.chatId === lastChatMemo);
  if (lastIndex !== -1) {
    const next = chat.message[lastIndex + 1];
    return next ? await processHypaV3Message(next, lastIndex + 1, shouldProcess) : null;
  }

  const firstMessage = getFirstMessage();
  if (firstMessage) {
    return await processHypaV3Message(
      { role: "char", chatId: "first", data: firstMessage },
      -1,
      shouldProcess
    );
  }

  return chat.message[0] ? await processHypaV3Message(chat.message[0], 0, shouldProcess) : null;
}

export function getCategoryName(
  categoryId: string | undefined,
  categories: Category[]
): string {
  const category = categories.find(c => c.id === (categoryId || ""));
  return category?.name || language.hypaV3Modal.unclassified;
}

export function getCategoriesWithUnclassified(
  categories: Category[] | undefined
): Category[] {
  const unclassified = { id: "", name: language.hypaV3Modal.unclassified };

  return [
    unclassified,
    ...(categories ?? []).filter((category) => category.id !== ""),
  ];
}

export function createCategoryId(): string {
  return `cat_${Date.now()}`;
}

export function shouldShowSummary(
  summary: SerializableSummary,
  showImportantOnly: boolean,
  selectedCategoryFilter: string
): boolean {
  return (
    (!showImportantOnly || summary.isImportant === true) &&
    (selectedCategoryFilter === "all" || (summary.categoryId || "") === selectedCategoryFilter)
  );
}

export function isGuidLike(str: string): boolean {
  return /^[0-9a-f]{4,12}(-[0-9a-f]{4,12}){0,4}-?$/i.test(str.trim());
}
