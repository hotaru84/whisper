// Regenerates every app icon from the single vector source (app-icon.svg).
//
//   npm run icons
//
// `tauri icon` covers the desktop bundle set (32/64/128/128@2x, the Windows
// Store logos, icon.ico, icon.icns, icon.png). It also emits iOS/Android
// launcher icons, which this desktop-only app has no use for, and it never
// touches the web favicon -- so this script drops the former and refreshes the
// latter, which would otherwise silently keep the old artwork.
import { execFileSync } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "app-icon.svg");
const iconsDir = join(root, "src-tauri", "icons");

const tauri = (...args) => {
  console.log(`> tauri ${args.join(" ")}`);
  execFileSync("npx", ["--no-install", "tauri", ...args], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
};

tauri("icon", source);

for (const mobile of ["ios", "android"]) {
  rmSync(join(iconsDir, mobile), { recursive: true, force: true });
}

copyFileSync(join(iconsDir, "32x32.png"), join(root, "public", "favicon.png"));
console.log("public/favicon.png <- src-tauri/icons/32x32.png");
