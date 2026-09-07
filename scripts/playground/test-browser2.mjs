import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('Console error:', msg.text(), 'at', msg.location());
    }
  });
  page.on('pageerror', e => {
    console.log('Page error:', e.message, 'at', e.stack);
  });
  try {
    await page.goto('http://localhost:3005/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('Page title:', await page.title());
    // Check if the main script executed by looking for initialized elements
    const serverDot = await page.locator('#serverDot').getAttribute('style');
    console.log('Server dot style:', serverDot);
    const stServer = await page.locator('#stServer').textContent();
    console.log('stServer:', stServer);
  } catch (e) {
    console.log('Error:', e.message);
  }
  await browser.close();
})();