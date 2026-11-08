import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const { writable } = require("svelte/store");

  return {
    DBState: {
      db: {
        characters: [
          {
            chats: [{ message: [] }],
          },
        ],
      },
    },
    selectedCharID: writable(0),
    selIdState: { selId: 0 },
    risuChatParser: vi.fn((data: string) => `cbs:${data}`),
    processScriptFull: vi.fn(async (_char, data: string) => ({
      data: `regex:${data}`,
    })),
    translateHTML: vi.fn(async (html: string) => html),
    parseChatDisplayMessage: vi.fn((data: string) => `display:${data}`),
  };
});

vi.mock("src/ts/stores.svelte", () => ({
  DBState: mocks.DBState,
  selectedCharID: mocks.selectedCharID,
  selIdState: mocks.selIdState,
}));

vi.mock("src/ts/process/scripts", () => ({
  risuChatParser: mocks.risuChatParser,
  processScriptFull: mocks.processScriptFull,
  parseChatDisplayMessage: mocks.parseChatDisplayMessage,
}));

vi.mock("src/ts/process/memory/hypav3", () => ({
  getCurrentHypaV3Preset: () => ({
    settings: { processRegexScript: false },
  }),
}));

vi.mock("src/ts/alert", () => ({
  alertConfirm: vi.fn(),
}));

vi.mock("src/lang", () => ({
  language: {},
}));

vi.mock("src/ts/translator/translator", () => ({
  translateHTML: mocks.translateHTML,
}));

vi.mock("src/ts/util", () => ({
  getUserName: () => "Persona",
}));

import { processHypaV3Message, processMessageCBS, translateChatMessage } from "./utils";

describe("HypaV3 modal message processing", () => {
  beforeEach(() => {
    mocks.risuChatParser.mockClear();
    mocks.processScriptFull.mockClear();
  });

  it("always applies CBS with display-safe message context", async () => {
    const message = { role: "user" as const, data: "{{getvar::name}}" };

    const result = await processHypaV3Message(message, 3, false);

    expect(result.data).toBe("cbs:{{getvar::name}}");
    expect(mocks.risuChatParser).toHaveBeenCalledWith(
      message.data,
      expect.objectContaining({
        chatID: 3,
        role: "user",
        rmVar: true,
        cbsConditions: {
          chatRole: "user",
          firstmsg: false,
        },
      })
    );
    expect(mocks.processScriptFull).not.toHaveBeenCalled();
  });

  it("applies regex processing after CBS only when requested", async () => {
    const message = { role: "char" as const, data: "message" };

    const result = await processHypaV3Message(message, 1, true);

    expect(result.data).toBe("regex:cbs:message");
    expect(mocks.processScriptFull).toHaveBeenCalledWith(
      mocks.DBState.db.characters[0],
      "cbs:message",
      "editprocess",
      1,
      { chatRole: "char" }
    );
  });

  it("provides the first-message CBS condition for greetings", () => {
    processMessageCBS({ role: "char", data: "{{isfirstmsg}}" }, -1);

    expect(mocks.risuChatParser).toHaveBeenCalledWith(
      "{{isfirstmsg}}",
      expect.objectContaining({
        cbsConditions: {
          chatRole: "char",
          firstmsg: true,
        },
      })
    );
  });

  it("translates raw text under the chat's masked cache key", async () => {
    Object.assign(mocks.DBState.db, { translatorType: "llm", translateBeforeHTMLFormatting: true });
    const tag = '<lb-xnai translate="no" id="scene-1" operation="op-a" scene="1"></lb-xnai>';
    const message = { role: "user" as const, data: `Hi\n${tag}` };
    mocks.translateHTML.mockResolvedValueOnce('Hallo\n<x-notrans n="0"></x-notrans>');

    const result = await translateChatMessage(message, 2, "unused", false);

    expect(mocks.parseChatDisplayMessage).toHaveBeenCalledWith(message.data, {
      name: "Persona",
      chatID: 2,
      cbsConditions: { firstmsg: false, chatRole: "user" },
    });
    expect(mocks.translateHTML.mock.calls[0][0]).toBe('display:Hi\n<x-notrans n="0"></x-notrans>');
    expect(result).toBe(`Hallo\n${tag}`);
  });
});
