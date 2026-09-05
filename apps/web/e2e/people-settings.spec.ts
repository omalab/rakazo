import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("deployment owner can add an existing account from Settings", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const ownerEmail = `people-owner-${stamp}@rakazo.test`;
  const addedEmail = `liz-${stamp}@rakazo.test`;

  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: { me: { isDeploymentOwner: boolean } } };
    body.json.me.isDeploymentOwner = true;
    await route.fulfill({ response, json: body });
  });
  await page.route("**/rpc/people/list", (route) =>
    route.fulfill({
      contentType: "application/json",
      json: {
        json: [{ userId: "owner-1", name: "People Owner", email: ownerEmail, role: "owner" }],
      },
    }),
  );
  await page.route("**/rpc/people/add", async (route) => {
    const body = (await route.request().postDataJSON()) as { json: { email: string } };
    await route.fulfill({
      contentType: "application/json",
      json: {
        json: { userId: "member-1", name: "Liz", email: body.json.email, role: "member" },
      },
    });
  });

  await signup(page, ownerEmail, "password12", "People Owner");
  await completeOnboarding(page);
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const settings = page.getByTestId("user-settings");
  const people = settings.getByTestId("people-settings");
  await expect(people.getByRole("heading", { name: "People", exact: true })).toBeVisible();
  await expect(people.getByText(ownerEmail)).toBeVisible();

  await people.getByRole("textbox", { name: "Existing account email" }).fill(addedEmail);
  await people.getByRole("button", { name: "Add person" }).click();

  await expect(people.getByText(addedEmail)).toBeVisible();
  await expect(people.getByText("Access added")).toBeVisible();
  await people.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "people-settings-access-added");
});
