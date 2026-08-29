import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => {
    console.log('Page error:', e.message);
    console.log('Stack:', e.stack);
  });
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('Console error:', msg.text());
      console.log('Location:', msg.location());
    }
  });
  
  // Add listener before navigation
  await page.goto('http://localhost:3005/', { waitUntil: 'commit', timeout: 30000 });
  await page.waitForTimeout(2000);
  
  await browser.close();
})();