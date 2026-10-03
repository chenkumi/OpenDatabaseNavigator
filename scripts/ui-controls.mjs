// Interact with the same Base UI controls a desktop user sees.
export async function selectValue(page, trigger, value) {
  await trigger.click();
  const item = page
    .getByRole('option')
    .and(page.locator(`[data-value=${JSON.stringify(String(value))}]`));
  await item.click();
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
