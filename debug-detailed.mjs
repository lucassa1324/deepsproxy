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
  
  // Wait a bit for scripts to execute
  await page.waitForTimeout(2000);
  
  // Check if main script executed by looking for initialized elements
  const serverDot = await page.locator('#serverDot').getAttribute('style');
  console.log('Server dot style:', serverDot);
  const stServer = await page.locator('#stServer').textContent();
  console.log('stServer:', stServer);
  
  // Check if chat component loaded
  const chatMount = await page.locator('#chatMount').evaluate(el => el.children.length);
  console.log('Chat mount children:', chatMount);
  
  await browser.close();
})();