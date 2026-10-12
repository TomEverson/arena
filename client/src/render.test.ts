import { describe, expect, it } from "vitest";

import { FX_MODES, parseFx } from "./render";

describe("parseFx", () => {
  it("is off unless asked", () => {
    expect(parseFx(null)).toBe("off");
    expect(parseFx("nonsense")).toBe("off");
  });

  it("accepts every mode by name, and 'on' as the soft dither", () => {
    for (const m of FX_MODES) expect(parseFx(m.id)).toBe(m.id);
    expect(parseFx("on")).toBe("soft");
  });
});
