import { test, expect } from "@playwright/test";

test("supervises a fake story through progress, blocking and refresh", async ({ page }) => {
  await page.goto("/"); await expect(page.getByRole("heading", { name: "AI Factory" })).toBeVisible(); await expect(page.getByText("PROJECT DOCTOR")).toBeVisible();
  await page.getByRole("button", { name: "Backlog" }).click(); await expect(page.getByText("US-001 · P1")).toBeVisible();
  await page.getByRole("button", { name: "Executions", exact: true }).click(); await page.getByRole("button", { name: /Start execution/ }).click();
  await expect(page.getByText("fake Codex is still running")).toBeVisible(); await expect(page.getByText(/Run blocked:/)).toBeVisible(); await expect(page.getByText("fake reviewer requests human clarification", { exact: true })).toBeVisible();
  await page.getByLabel("Additional instruction").fill("Inspect the browser edge case"); await page.getByRole("button", { name: "Queue instruction" }).click(); await expect(page.getByText(/PENDING_NEXT_INVOCATION/)).toBeVisible();
  await page.reload(); await page.getByRole("button", { name: "Executions", exact: true }).click(); await expect(page.getByText("fake reviewer requests human clarification", { exact: true })).toBeVisible();
});
