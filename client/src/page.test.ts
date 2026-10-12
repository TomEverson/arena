import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Each page is plain HTML with its own <style> and one entry script. Editing the HTML by hand
 * once deleted the start menu's CSS and left the menu in the page but invisible and dead. These
 * checks follow a page's script (and the modules it imports) and make sure every element the
 * code looks for is in that page, and styled.
 */
const clientDir = fileURLToPath(new URL("..", import.meta.url));

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** The entry script and every relative module it imports, transitively. */
function modulesOf(entry: string): string[] {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of read(file).matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
      const target = resolve(dirname(file), m[1] as string);
      for (const candidate of [`${target}.ts`, target]) {
        if (candidate.endsWith(".ts") && existsSync(candidate)) walk(candidate);
      }
    }
  };
  walk(entry);
  return [...seen];
}

function idsUsedBy(files: string[]): string[] {
  const ids = new Set<string>();
  for (const file of files) {
    for (const m of read(file).matchAll(/getElementById\("([\w-]+)"\)/g)) ids.add(m[1] as string);
  }
  return [...ids].sort();
}

function page(name: string) {
  const html = read(`${clientDir}${name}`);
  const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  const entry = /<script type="module" src="\/([^"]+)"/.exec(html)?.[1];
  if (!entry) throw new Error(`${name} has no module script`);
  return { html, style, ids: idsUsedBy(modulesOf(`${clientDir}${entry}`)) };
}

// Styled through a parent rule or by tag name, so they need no rule of their own.
const STYLED_VIA_PARENT = new Set([
  "game",
  "hinttext",
  "play-ffa",
  "play-practice",
  // The viewer's controls, all inside #panel.
  "model",
  "weapon",
  "anim",
  "replay",
  "hitbox",
  "aim",
  "fire",
  "fx",
  "panel",
]);

describe.each(["index.html", "figure.html"])("%s", (name) => {
  const { html, style, ids } = page(name);

  it("contains every element its code looks for", () => {
    for (const id of ids) expect(html, `missing element #${id}`).toContain(`id="${id}"`);
  });

  it("styles every overlay its code drives (an unstyled one is invisible or sits under the game)", () => {
    for (const id of ids.filter((i) => !STYLED_VIA_PARENT.has(i))) {
      expect(style, `no CSS for #${id}`).toContain(`#${id}`);
    }
  });
});

describe("the game page", () => {
  const { html, style, ids } = page("index.html");

  it("looks for a decent number of elements (the crawl is working)", () => {
    expect(ids.length).toBeGreaterThan(15);
    expect(html).toContain("<canvas");
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
