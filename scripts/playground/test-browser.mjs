import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto('http://localhost:3005/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    console.log('Page title:', await page.title());
    console.log('Errors:', errors);
    const buttons = await page.locator('aside.sidebar button').all();
    console.log('Sidebar buttons found:', buttons.length);
    for (const btn of buttons) {
      const text = await btn.textContent();
      const tab = await btn.getAttribute('data-tab');
      console.log('  Button:', text.trim(), 'data-tab:', tab);
    }
    if (buttons.length > 1) {
      await buttons[1].click();
      await page.waitForTimeout(500);
      console.log('Clicked second button');
      const activeTab = await page.locator('section.tab.active').getAttribute('id');
      console.log('Active tab after click:', activeTab);
    }
  } catch (e) {
    console.log('Error:', e.message);
  }
  console.log('All errors:', errors);
  await browser.close();
})();