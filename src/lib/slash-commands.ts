import type { PiCommand } from "@/lib/types";

export const DESKTOP_SLASH_COMMANDS: readonly PiCommand[] = [
  {
    name: "new",
    description: "Start a clean Pi session",
    source: "desktop",
  },
  {
    name: "model",
    description: "Choose the active model",
    source: "desktop",
  },
  {
    name: "settings",
    description: "Open app and project settings",
    source: "desktop",
  },
  {
    name: "login",
    description: "Configure provider credentials",
    source: "desktop",
  },
  {
    name: "packages",
    description: "Install and manage Pi packages",
    source: "desktop",
  },
];

export function matchingSlashCommands(
  text: string,
  piCommands: readonly PiCommand[],
  limit = 6,
): PiCommand[] {
  const match = /^\/([^\s]*)$/.exec(text);
  if (!match) return [];

  const query = match[1].toLowerCase();
  const commands = new Map<string, PiCommand>();
  for (const command of [...DESKTOP_SLASH_COMMANDS, ...piCommands]) {
    const name = typeof command.name === "string" ? command.name.trim() : "";
    if (!name || commands.has(name.toLowerCase())) continue;
    commands.set(name.toLowerCase(), { ...command, name });
  }

  return [...commands.values()]
    .filter((command) =>
      `${command.name} ${command.description ?? ""}`.toLowerCase().includes(query),
    )
    .slice(0, limit);
}

export function desktopSlashCommand(text: string): string | null {
  const match = /^\/([^\s]+)\s*$/.exec(text);
  if (!match) return null;
  const name = match[1].toLowerCase();
  return DESKTOP_SLASH_COMMANDS.some((command) => command.name === name) ? name : null;
}
