import { expect } from '@playwright/test';

// Interact with the same Base UI controls a desktop user sees.
export async function selectValue(page, trigger, value) {
  // Open via keyboard: an aligned popup can place its selected item under
  // the pointer, so a synthetic click's release may immediately select/close it.
  await trigger.press('ArrowDown');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(trigger).toHaveAttribute('aria-controls', /.+/);
  const listId = await trigger.getAttribute('aria-controls');
  // A previous popup can remain mounted during its exit animation.
  const item = page
    .locator(`[id=${JSON.stringify(listId)}]`)
    .getByRole('option')
    .and(page.locator(`[data-value=${JSON.stringify(String(value))}]`));
  await item.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
}
export async function acceptConfirmation(page) {
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: /^(Continue|繼續)$/ })
    .click();
}
export async function dismissConfirmation(page) {
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: /^(Cancel|取消)$/ })
    .click();
}
