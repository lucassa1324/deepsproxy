import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // Capture all console messages
  page.on('console', msg => {
    console.log('Console:', msg.type(), msg.text());
    if (msg.type() === 'error') {
      console.log('Location:', msg.location());
    }
  });
  
  // Capture page errors
  page.on('pageerror', e => {
    console.log('Page error:', e.message);
    console.log('Stack:', e.stack);
  });
  
  // Navigate
  await page.goto('http://localhost:3005/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  
  await browser.close();
})();