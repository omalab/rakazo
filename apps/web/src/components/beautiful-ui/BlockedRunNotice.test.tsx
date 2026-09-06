import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BlockedRunNotice } from "./BlockedRunNotice";

describe("BlockedRunNotice", () => {
  it("names the blocked bot and offers the exact recovery action", () => {
    const html = renderToString(
      <BlockedRunNotice botName="James Baker" onOpenComputer={vi.fn()} />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('data-testid="blocked-run-notice"');
    expect(html).toContain("James Baker needs you");
    expect(html).toContain("Open the computer to continue this task.");
    expect(html).toContain("Open computer");
  });
});
