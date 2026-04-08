// End-to-end test for stock-gallery: full user journey through the actual UI.
// Runs in real headless Chromium against the live container on the ollamawulf network.
//
// IMPORTANT: this test triggers a real GPU gen (~60-90s). Do not run it in tight loops
// without intent — it stops Ollama, runs ComfyUI, restarts Ollama. Bayou regressions
// are checked at the end as a separate spec.

import { test, expect } from "@playwright/test";

const PROMPT = `playwright e2e ${Date.now()}`;
const STYLE = "raw"; // skip LLM rewrite for speed; tag extraction still runs
const ORIENTATION = "square";

test.describe("stock-gallery — full user journey", () => {
  test("page loads with all UI elements", async ({ page }) => {
    await page.goto("/");

    // Masthead
    await expect(page).toHaveTitle(/STOCK · silverwulf/);
    await expect(page.locator("h1.mast")).toContainText(/stock/);

    // Compose panel
    await expect(page.locator("#compose")).toBeVisible();
    await expect(page.locator("#cmp-prompt")).toBeVisible();
    await expect(page.locator("#cmp-style")).toBeVisible();
    await expect(page.locator("#cmp-submit")).toBeVisible();

    // Tag dropdown
    await expect(page.locator("#tag-filter")).toBeVisible();
    const tagOptions = await page.locator("#tag-filter option").count();
    expect(tagOptions).toBeGreaterThan(2); // at least "all" + 1 tag + untagged

    // Grid + at least one tile
    const tileCount = await page.locator("figure.tile").count();
    expect(tileCount).toBeGreaterThan(0);

    // Lightbox markup present (closed)
    await expect(page.locator("#lightbox")).toBeAttached();
    await expect(page.locator("#lightbox")).not.toHaveClass(/open/);
  });

  test("cache headers are no-store on api + html (regression for the polling freeze)", async ({ request }) => {
    const html = await request.get("/");
    expect(html.headers()["cache-control"]).toContain("no-store");

    const queue = await request.get("/api/queue");
    expect(queue.headers()["cache-control"]).toContain("no-store");

    const tags = await request.get("/api/tags");
    expect(tags.headers()["cache-control"]).toContain("no-store");

    const styles = await request.get("/api/styles");
    expect(styles.headers()["cache-control"]).toContain("no-store");
  });

  test("clicking a tile opens the lightbox with prompt visible", async ({ page }) => {
    await page.goto("/");
    // Pick the first tile that has a data-prompt (skip legacy untagged ones)
    const tile = page.locator("figure.tile[data-prompt]").first();
    await expect(tile).toBeVisible();
    const prompt = await tile.getAttribute("data-prompt");
    expect(prompt).toBeTruthy();

    await tile.click();

    await expect(page.locator("#lightbox")).toHaveClass(/open/);
    await expect(page.locator("#lightbox-img")).toBeVisible();
    // Caption should contain the prompt as italic text
    const caption = page.locator("#lightbox-caption");
    await expect(caption).toContainText(prompt.slice(0, 30));

    // Close on click
    await page.locator("#lightbox").click({ position: { x: 10, y: 10 } });
    await expect(page.locator("#lightbox")).not.toHaveClass(/open/);
  });

  test("tag filter actually filters and updates count", async ({ page }) => {
    await page.goto("/");
    // Pick the most-frequent real tag from the dropdown
    const firstRealTag = await page.locator('#tag-filter option[value]:not([value=""]):not([value="__untagged__"])').first().getAttribute("value");
    test.skip(!firstRealTag, "no tags in dropdown to test");

    await page.selectOption("#tag-filter", firstRealTag);
    await page.waitForURL(new RegExp(`tag=${encodeURIComponent(firstRealTag)}`));

    // After filter, the visible tile count must be > 0 and the masthead "num" reflects it
    const filteredCount = await page.locator("figure.tile").count();
    expect(filteredCount).toBeGreaterThan(0);
    // The masthead num is zero-padded
    const numText = await page.locator("header .meta-col .num").textContent();
    expect(numText).toMatch(/^\d{3}$/);
  });

  test("submit gen → queue panel appears → auto-reload shows new tile (the BIG one)", async ({ page }) => {
    test.setTimeout(240_000); // up to 4 min for the full gen cycle

    await page.goto("/");
    const tilesBefore = await page.locator("figure.tile").count();

    // Type prompt
    await page.fill("#cmp-prompt", PROMPT);
    await page.selectOption("#cmp-style", STYLE);
    // Pick orientation
    await page.click(`.seg-btn[data-orient="${ORIENTATION}"]`);
    // Variations = 1
    await page.click('.seg-btn[data-var="1"]');

    // Submit
    await page.click("#cmp-submit");

    // Queue panel should become visible within a few seconds
    await expect(page.locator("#queue-panel")).toBeVisible({ timeout: 10_000 });

    // The header queue indicator should appear with count
    await expect(page.locator("#hdr-queue")).toBeVisible({ timeout: 10_000 });

    // Wait for the auto-reload (polling JS detects done → location.reload after ~400ms)
    // The page navigation will fire; we wait for the new tile count to be > before
    await page.waitForFunction(
      (before) => document.querySelectorAll("figure.tile").length > before,
      tilesBefore,
      { timeout: 200_000 }
    );

    // New tile should be at the top-left and should have data-prompt matching ours
    const firstTilePrompt = await page.locator("figure.tile").first().getAttribute("data-prompt");
    expect(firstTilePrompt).toBe(PROMPT);

    // Sidecar metadata should be present
    const firstTileTags = await page.locator("figure.tile").first().getAttribute("data-tags");
    expect(firstTileTags).toBeTruthy(); // should have at least one tag from extractTags
  });

  test("lightbox of the freshly-generated tile shows the prompt and tags", async ({ page }) => {
    await page.goto("/");
    // Find OUR test tile via data-prompt
    const tile = page.locator(`figure.tile[data-prompt="${PROMPT}"]`).first();
    await expect(tile).toBeVisible();

    await tile.click();
    await expect(page.locator("#lightbox")).toHaveClass(/open/);

    const caption = page.locator("#lightbox-caption");
    await expect(caption).toContainText(PROMPT);

    // Tag chips should be clickable links to /?tag=
    const tagLinks = page.locator(".lb-tag");
    const tagCount = await tagLinks.count();
    expect(tagCount).toBeGreaterThan(0);
  });
});

test.describe("stock-gallery — regression checks", () => {
  test("bayou still chats (sanity check after our gen stop/started ollama)", async ({ request }) => {
    const r = await request.post("https://bayou.silverwulf.work/api/chat", {
      data: { messages: [{ role: "user", content: "hi" }] },
      timeout: 60_000,
    });
    expect(r.ok()).toBeTruthy();
    const j = await r.json();
    expect(j.route).toBeTruthy();
    expect(j.assistantMessage).toBeTruthy();
  });
});
