import { describe, expect, it } from "vitest";

import { closeReason, modeFromUrl, roomFromUrl, roomLink } from "./rooms";

describe("mode from the URL", () => {
  it("accepts the two modes in any case", () => {
    expect(modeFromUrl("?mode=practice")).toBe("practice");
    expect(modeFromUrl("?mode=FFA")).toBe("ffa");
    expect(modeFromUrl("?res=360&mode=Practice")).toBe("practice");
  });

  it("returns null for anything else, so the start screen shows", () => {
    expect(modeFromUrl("")).toBeNull();
    expect(modeFromUrl("?mode=")).toBeNull();
    expect(modeFromUrl("?mode=ctf")).toBeNull();
  });
});

describe("room links", () => {
  it("reads the code from the URL, any case", () => {
    expect(roomFromUrl("?room=k7qwm")).toBe("K7QWM");
    expect(roomFromUrl("?res=360&room=AB2CD")).toBe("AB2CD");
    expect(roomFromUrl("?room=%20ab2cd%20")).toBe("AB2CD");
  });

  it("returns null when there is no room", () => {
    expect(roomFromUrl("")).toBeNull();
    expect(roomFromUrl("?res=360")).toBeNull();
    expect(roomFromUrl("?room=")).toBeNull();
  });

  it("builds a link a friend can open", () => {
    expect(roomLink("http://localhost:5173", "/", "K7QWM")).toBe(
      "http://localhost:5173/?room=K7QWM",
    );
    expect(roomLink("https://arena.example", "/play/", "A")).toBe(
      "https://arena.example/play/?room=A",
    );
  });

  it("explains why the server refused us", () => {
    expect(closeReason(4001)).toMatch(/does not exist/);
    expect(closeReason(4002)).toMatch(/full/);
    expect(closeReason(1006)).toBeNull();
  });
});
