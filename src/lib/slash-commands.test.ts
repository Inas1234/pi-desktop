import { desktopSlashCommand, matchingSlashCommands } from "@/lib/slash-commands";

describe("slash commands", () => {
  it("shows desktop commands for a stock Pi installation", () => {
    expect(matchingSlashCommands("/", []).map((command) => command.name)).toEqual([
      "new",
      "model",
      "settings",
      "login",
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

  it("closes suggestions after command arguments begin", () => {
    expect(matchingSlashCommands("/skill:review notes", [{ name: "skill:review" }])).toEqual([]);
  });

  it("recognizes only commands handled by the desktop", () => {
    expect(desktopSlashCommand("/settings ")).toBe("settings");
    expect(desktopSlashCommand("/skill:review ")).toBeNull();
  });
});
