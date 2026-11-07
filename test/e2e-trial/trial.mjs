// Launch Playwright's Chromium headless shell, render a page, print the result as JSON.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<html><body><h1 id="t">Café, 東京, ✓</h1><script>document.title = String(6 * 7)</script></body></html>');
const result = {
  browser: browser.version(),
  title: await page.title(),
  text: await page.textContent('#t'),
  screenshotBytes: (await page.screenshot()).length,
};
await browser.close();
console.log(JSON.stringify(result));
if (result.title !== '42') process.exit(1);
