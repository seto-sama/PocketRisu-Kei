import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const { writable } = require("svelte/store");

  return {
    DBState: {
      db: {
        characters: [
          {
            chatPage: 0,
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

import { processHypaV3Message, processMessageCBS } from "./utils";

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
    processMessageCBS({ role: "char", data: "{{isfirstmsg}}" }, -1, true);

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
});
