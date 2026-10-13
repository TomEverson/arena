import { describe, expect, it } from "vitest";

import { cleanUsername, USERNAME_MAX } from "./username";

describe("cleanUsername", () => {
  it("trims and collapses spaces", () => {
    expect(cleanUsername("  Tom   E  ")).toBe("Tom E");
  });

  it("drops line breaks and control characters", () => {
    expect(cleanUsername("To\nm\t\u0007!")).toBe("To m !");
  });

  it("cuts a long name to the limit without leaving a trailing space", () => {
    const name = cleanUsername("abcdefghijklmno pqrstuvwxyz");
    expect(name.length).toBeLessThanOrEqual(USERNAME_MAX);
    expect(name).toBe("abcdefghijklmno");
  });

  it("gives nothing for a blank name", () => {
    expect(cleanUsername("   \n ")).toBe("");
  });
});
