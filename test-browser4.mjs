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
  try {
    await page.goto('http://localhost:3005/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
    const serverDot = await page.locator('#serverDot').getAttribute('style');
    console.log('Server dot style:', serverDot);
    const stServer = await page.locator('#stServer').textContent();
    console.log('stServer:', stServer);
    
    // Check if loadStatus ran by looking for status elements
    const stProvider = await page.locator('#stProvider').textContent();
    console.log('stProvider:', stProvider);
    
    // Try clicking the Chat tab
    const chatBtn = page.locator('aside.sidebar button[data-tab="chat"]');
    await chatBtn.click();
    await page.waitForTimeout(500);
    const activeTab = await page.locator('section.tab.active').getAttribute('id');
    console.log('Active tab after click:', activeTab);
  } catch (e) {
    console.log('Error:', e.message);
  }
  await browser.close();
})();