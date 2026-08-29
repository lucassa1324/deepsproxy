import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => {
    console.log('Page error:', e.message);
    console.log('Stack:', e.stack);
  });
  page.on('console', msg => {
    console.log('Console:', msg.type(), msg.text(), msg.location());
  });
  
  // Navigate and wait for load
  await page.goto('http://localhost:3005/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  
  // Get the exact error from the main script by evaluating
  const error = await page.evaluate(() => {
    try {
      // Try to run the main script's loadStatus function
      if (typeof loadStatus === 'function') {
        return loadStatus();
      }
      return 'loadStatus not defined';
    } catch (e) {
      return 'Error: ' + e.message + '\nStack: ' + e.stack;
    }
  });
  console.log('Eval result:', error);
  
  await browser.close();
})();