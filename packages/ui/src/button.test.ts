import { describe, expect, it } from "vitest";
import { buttonClass } from "./button.ts";

describe("buttonClass", () => {
  it("puts a tone on a secondary or ghost button", () => {
    expect(buttonClass({ tone: "ok" })).toBe("btn btn-ok");
    expect(buttonClass({ variant: "ghost", tone: "bad", size: "sm" })).toBe("btn btn-ghost btn-bad btn-sm");
  });

  it("keeps the primary button monochrome", () => {
    expect(buttonClass({ variant: "primary", tone: "ok" })).toBe("btn btn-primary");
  });

  it("drops the tone while the button is disabled, so a blocked action never reads as go or look", () => {
    expect(buttonClass({ tone: "ok", disabled: true })).toBe("btn");
    expect(buttonClass({ variant: "ghost", tone: "warn", disabled: true, className: "x" })).toBe("btn btn-ghost x");
  });
});
