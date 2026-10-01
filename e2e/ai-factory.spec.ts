import { test, expect } from "@playwright/test";

test("supervises the offline implementation-review-fix lifecycle and merge gate", async ({ page }) => {
  await page.goto("/"); await expect(page.getByRole("heading", { name: "AI Factory" })).toBeVisible(); await expect(page.getByText("PROJECT DOCTOR")).toBeVisible();
  await page.getByRole("button", { name: "Backlog" }).click(); await expect(page.getByText("US-001 · P1")).toBeVisible();
  await page.getByRole("button", { name: "Executions", exact: true }).click(); await page.getByRole("button", { name: /Start execution/ }).click();
  await expect(page.getByText("fake implementer running")).toBeVisible(); await expect(page.getByText(/Run blocked:/)).toBeVisible(); await expect(page.getByText("MERGE_PENDING_APPROVAL: awaiting human merge approval", { exact: true })).toBeVisible(); await expect(page.getByText("Esperando merge humano").first()).toBeVisible(); await expect(page.getByText("REVALIDATING")).toBeVisible();
  await page.getByRole("button", { name: "Human validation" }).click(); await expect(page.getByText("MERGE", { exact: true })).toBeVisible(); await page.getByRole("button", { name: "Executions", exact: true }).click();
  await page.getByLabel("Additional instruction").fill("Inspect the browser edge case"); await page.getByRole("button", { name: "Queue instruction" }).click(); await expect(page.getByText(/PENDING_NEXT_INVOCATION/)).toBeVisible();
  await page.reload(); await page.getByRole("button", { name: "Executions", exact: true }).click(); await expect(page.getByText("MERGE_PENDING_APPROVAL: awaiting human merge approval", { exact: true })).toBeVisible();
});
