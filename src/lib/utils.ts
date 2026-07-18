import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
}

export function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function stripTerminalFormatting(value: string): string {
  let result = "";
  let index = 0;

  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const next = value.charCodeAt(index + 1);
      if (next === 0x5b) {
        index += 2;
        while (index < value.length) {
          const final = value.charCodeAt(index++);
          if (final >= 0x40 && final <= 0x7e) break;
        }
        continue;
      }
      if (next === 0x5d) {
        index += 2;
        while (index < value.length) {
          if (value.charCodeAt(index) === 0x07) {
            index += 1;
            break;
          }
          if (value.charCodeAt(index) === 0x1b && value.charCodeAt(index + 1) === 0x5c) {
            index += 2;
            break;
          }
          index += 1;
        }
        continue;
      }
      index += Math.min(2, value.length - index);
      continue;
    }
    if (code === 0x9b) {
      index += 1;
      while (index < value.length) {
        const final = value.charCodeAt(index++);
        if (final >= 0x40 && final <= 0x7e) break;
      }
      continue;
    }
    result += value[index];
    index += 1;
  }

  return result;
}
