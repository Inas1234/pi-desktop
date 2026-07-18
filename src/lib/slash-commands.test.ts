import {
  desktopSlashCommand,
  interactiveSlashCommand,
  matchingSlashCommands,
} from "@/lib/slash-commands";

describe("slash commands", () => {
  it("shows desktop commands for a stock Pi installation", () => {
    expect(matchingSlashCommands("/", []).map((command) => command.name)).toEqual([
      "new",
      "model",
      "settings",
      "login",
      "packages",
    ]);
  });

  it("merges and filters commands supplied by Pi", () => {
    const commands = matchingSlashCommands("/rev", [
      { name: "review", description: "Review the current change", source: "extension" },
      { name: "skill:review", description: "Run the review skill", source: "skill" },
    ]);

    expect(commands.map((command) => command.name)).toEqual(["review", "skill:review"]);
  });

  it("keeps desktop behavior when Pi supplies a duplicate name", () => {
    const [command] = matchingSlashCommands("/new", [
      { name: "new", description: "Conflicting extension", source: "extension" },
    ]);

    expect(command).toMatchObject({ name: "new", source: "desktop" });
  });

  it("keeps Pi's catalog order and metadata while retaining desktop behavior", () => {
    const commands = matchingSlashCommands("/", [
      {
        name: "settings",
        description: "Open settings menu",
        source: "builtin",
        invocation: "interactive",
      },
      {
        name: "model",
        description: "Select model",
        argumentHint: "<provider/model>",
        source: "builtin",
        invocation: "interactive",
      },
      {
        name: "compact",
        description: "Manually compact context",
        source: "builtin",
        invocation: "interactive",
      },
    ]);

    expect(commands.slice(0, 3)).toEqual([
      expect.objectContaining({
        name: "settings",
        description: "Open settings menu",
        source: "desktop",
      }),
      expect.objectContaining({
        name: "model",
        argumentHint: "<provider/model>",
        source: "desktop",
      }),
      expect.objectContaining({ name: "compact", source: "builtin" }),
    ]);
  });

  it("closes suggestions after command arguments begin", () => {
    expect(matchingSlashCommands("/skill:review notes", [{ name: "skill:review" }])).toEqual([]);
  });

  it("recognizes only commands handled by the desktop", () => {
    expect(desktopSlashCommand("/settings ")).toBe("settings");
    expect(desktopSlashCommand("/packages ")).toBe("packages");
    expect(desktopSlashCommand("/skill:review ")).toBeNull();
  });

  it("recognizes terminal-only Pi commands so they are not sent as model prompts", () => {
    const command = interactiveSlashCommand("/compact now", [
      {
        name: "compact",
        source: "builtin",
        invocation: "interactive",
      },
    ]);

    expect(command?.name).toBe("compact");
    expect(
      interactiveSlashCommand("/review", [{ name: "review", source: "extension" }]),
    ).toBeNull();
  });
});
