import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { initI18n } from "../../i18n.ts";
import { item } from "./goals.tsx";

// The `Goals paused` status item (design §3.6, §5.2): nothing while goals run, and only while the
// global switch is on does it say so, with Resume.

const i18n = initI18n("en");

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

function render(state: unknown): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (state !== undefined) qc.setQueryData(["goals.state", undefined], state);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(item.component)));
}

describe("goals status item", () => {
  it("shows Goals paused with Resume only while Pause all goals is on", () => {
    const html = render({ enabled: true, pausedAll: true });
    expect(html).toContain("Goals paused");
    expect(html).toContain("Resume");
  });

  it("draws nothing while goals run, before the state is read, or for an answer that is not the state", () => {
    expect(render({ enabled: true, pausedAll: false })).toBe("");
    expect(render(undefined)).toBe("");
    expect(render({ id: "t1", status: "running" })).toBe("");
  });

  it("reads naturally in Turkish", async () => {
    await i18n.changeLanguage("tr");
    expect(render({ enabled: true, pausedAll: true })).toContain("Sürdür");
  });
});
