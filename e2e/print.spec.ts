import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const clip = readFileSync('tests/fixtures/reference-written.json', 'utf8');

async function openWithClip(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByLabel('Hookpad clip').fill(clip);
  await page.getByLabel('Written for B♭').check();
  await expect(page.locator('#sheet-host svg').first()).toBeVisible();
  expect(errors).toEqual([]);
}

test('prints a clean A4 page', async ({ page }) => {
  await openWithClip(page);
  await expect(page.locator('#sheet-host')).toHaveAttribute('data-onsets', '36');

  const pdf = (await page.pdf({ preferCSSPageSize: true })).toString('latin1');
  expect(pdf.match(/\/Type\s*\/Page\b/g)).toHaveLength(1);
  const [, width, height] = /\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf)!;
  expect(Math.abs(Number(width) - 595)).toBeLessThan(2);
  expect(Math.abs(Number(height) - 842)).toBeLessThan(2);

  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.panel')).toBeHidden();
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(page.locator('#sheet-host svg').first()).toBeVisible();
});

test('remembers settings and hides fingerings', async ({ page }) => {
  await openWithClip(page);
  const fingerings = page.locator('#sheet-host .abcjs-lyric', { hasText: /\d/ });
  await expect(fingerings).not.toHaveCount(0);
  await page.getByLabel('None').check();
  await expect(fingerings).toHaveCount(0);

  await page.reload();
  await expect(page.getByLabel('None')).toBeChecked();
  await expect(page.locator('#sheet-host svg').first()).toBeVisible();
  await expect(fingerings).toHaveCount(0);
});

test('dark mode darkens the sheet on screen but not in print', async ({ page }) => {
  await openWithClip(page);
  const sheet = page.locator('.notation-sheet');
  const background = () => sheet.evaluate((el) => getComputedStyle(el).backgroundColor);
  const printed = async () => {
    await page.emulateMedia({ media: 'print' });
    const image = await page.screenshot();
    await page.emulateMedia({ media: 'screen' });
    return image;
  };
  const lightPrint = await printed();
  expect(await background()).toBe('rgb(255, 255, 255)');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Dark').check();
  await page.getByRole('button', { name: 'Done' }).click();
  expect(await background()).not.toBe('rgb(255, 255, 255)');
  expect((await printed()).equals(lightPrint)).toBe(true);

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('System').check();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await background()).not.toBe('rgb(255, 255, 255)');
  expect((await printed()).equals(lightPrint)).toBe(true);
});

test('pasting another clip appends it, and choosing a key by keyboard keeps focus', async ({ page }) => {
  await openWithClip(page);
  await page.getByLabel('Written for B♭').focus();
  await page.evaluate((text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }));
  }, clip);
  await expect(page.locator('summary')).toHaveText('72 notes from 2 clips');

  await page.locator('.choice').nth(1).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.choice').nth(1)).toBeFocused();
  await expect(page.locator('.choice').nth(1)).toHaveAttribute('aria-pressed', 'true');
});
