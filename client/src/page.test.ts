import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The page is plain HTML with one big <style>. Editing it by hand once deleted the start menu's
 * CSS and left the menu in the page but invisible and dead. These checks catch that class of slip.
 */
const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
const sourceDir = fileURLToPath(new URL(".", import.meta.url));

function idsUsedByCode(): string[] {
  const ids = new Set<string>();
  for (const file of readdirSync(sourceDir, { recursive: true }) as string[]) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const text = readFileSync(`${sourceDir}${file}`, "utf8");
    for (const m of text.matchAll(/getElementById\("([\w-]+)"\)/g)) ids.add(m[1] as string);
  }
  return [...ids].sort();
}

describe("index.html", () => {
  const ids = idsUsedByCode();

  it("finds the elements the code looks for", () => {
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(html, `missing element #${id}`).toContain(`id="${id}"`);
  });

  it("styles every overlay the code drives (an unstyled one is invisible or sits under the game)", () => {
    // These are styled through their parent or by tag, so they need no rule of their own.
    const viaParent = new Set(["game", "hinttext", "play-ffa", "play-practice"]);
    for (const id of ids.filter((i) => !viaParent.has(i))) {
      expect(style, `no CSS for #${id}`).toContain(`#${id}`);
    }
  });

  it("keeps the start menu on top of everything, and only showing when switched on", () => {
    expect(style).toMatch(/#menu\s*\{[^}]*position:\s*fixed/);
    expect(style).toMatch(/#menu\s*\{[^}]*z-index:\s*10/);
    expect(style).toMatch(/#menu\s*\{[^}]*display:\s*none/);
    expect(style).toMatch(/#menu\.on\s*\{[^}]*display:\s*flex/);
  });

  it("has both start buttons styled", () => {
    expect(style).toMatch(/#menu button\s*\{/);
  });
});
