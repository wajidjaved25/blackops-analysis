import { expect, test } from '@playwright/test';

const email = `viewer${Date.now()}@example.com`;
const initial = 'Initial-pass-12345';
const final = 'Viewer-final-pass-123';

test('viewer is restricted (nav hidden, buttons disabled, 403 page)', async ({ browser }) => {
  // 1. Admin creates a Viewer through the UI.
  const a = await (await browser.newContext()).newPage();
  await a.goto('/login');
  await a.getByLabel('Email').fill('admin@example.com');
  await a.getByLabel('Password').fill('correct-horse-battery');
  await a.getByRole('button', { name: 'Sign in' }).click();
  await a.waitForURL('**/');
  await a.goto('/admin/users');
  await a.getByRole('button', { name: /Create user/ }).click();
  const dlg = a.getByRole('dialog', { name: 'Create user' });
  await dlg.getByLabel('Name').fill('Vera Viewer');
  await dlg.getByLabel('Email').fill(email);
  await dlg.getByLabel('Role').selectOption({ label: 'Viewer' });
  await dlg.getByLabel('Initial password').fill(initial);
  await dlg.getByRole('button', { name: 'Create user' }).click();
  await expect(a.getByText(email)).toBeVisible();
  await a.screenshot({ path: 'e2e/screenshots/rbac-users.png' });

  // 2. Viewer signs in, is forced to change the password, then sees a restricted UI.
  const v = await (await browser.newContext()).newPage();
  await v.goto('/login');
  await v.getByLabel('Email').fill(email);
  await v.getByLabel('Password').fill(initial);
  await v.getByRole('button', { name: 'Sign in' }).click();
  await v.waitForURL('**/');
  await v.getByText('Choose a new password').waitFor({ timeout: 10_000 }).catch(() => {});
  if (await v.getByText('Choose a new password').isVisible()) {
    await v.getByLabel('Current password').fill(initial);
    await v.getByLabel('New password', { exact: true }).fill(final);
    await v.getByLabel('Repeat new password').fill(final);
    await v.getByRole('button', { name: 'Change password' }).click();
    await v.waitForTimeout(1500);
  }
  await v.goto('/');
  await expect(v.getByRole('navigation').getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
  await expect(v.getByRole('navigation').getByRole('link', { name: 'Screening', exact: true })).toBeVisible();
  await v.screenshot({ path: 'e2e/screenshots/rbac-viewer-dashboard.png' });
  await v.goto('/cases');
  await expect(v.getByRole('button', { name: /New case/ })).toBeDisabled();
  await v.goto('/admin/users');
  await expect(v.getByText("You don't have permission for this")).toBeVisible();
  await v.screenshot({ path: 'e2e/screenshots/rbac-403.png' });
});
