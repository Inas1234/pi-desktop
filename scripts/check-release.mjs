import { existsSync, readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tauriConfig = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);
const cargoToml = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
const cargoVersion = cargoToml.match(/^version = "([^"]+)"$/m)?.[1];
const versions = new Map([
  ["package.json", packageJson.version],
  ["src-tauri/Cargo.toml", cargoVersion],
  ["src-tauri/tauri.conf.json", tauriConfig.version],
]);
const expected = packageJson.version;
const failures = [];

for (const [file, version] of versions) {
  if (version !== expected) failures.push(`${file} has version ${version ?? "missing"}`);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected)) {
  failures.push(`package.json has invalid release version ${expected}`);
}
if (tauriConfig.identifier === "dev.pi.desktop" || !tauriConfig.identifier.includes(".")) {
  failures.push("src-tauri/tauri.conf.json still has a development identifier");
}
if (!cargoToml.includes('license = "MIT"') || packageJson.license !== "MIT") {
  failures.push("MIT license metadata is not synchronized");
}
if (!existsSync(new URL("../LICENSE", import.meta.url))) failures.push("LICENSE is missing");
if (!readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").includes(`## ${expected}`)) {
  failures.push(`CHANGELOG.md has no ${expected} entry`);
}

if (failures.length) {
  console.error(`Release metadata check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(`Release metadata is synchronized at ${expected}.`);
