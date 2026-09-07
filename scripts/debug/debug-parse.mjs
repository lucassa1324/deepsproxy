import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', e => {
    console.log('Page error:', e.message);
    console.log('Stack:', e.stack);
  });
  page.on('console', msg => {
    console.log('Console:', msg.type(), msg.text());
  });
  await page.goto('http://localhost:3005/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1000);
  
  // Try to find and evaluate the script manually
  const scriptContent = await page.evaluate(() => {
    const scripts = document.querySelectorAll('script:not([type="module"])');
    for (const script of scripts) {
      if (script.textContent && script.textContent.includes('loadStatus')) {
        return script.textContent.substring(0, 500);
      }
    }
    return null;
  });
  console.log('Main script found:', !!scriptContent);
  if (scriptContent) {
    console.log('First 500 chars:', scriptContent);
  }
  
  // Try evaluating parts
  const result = await page.evaluate(() => {
    try {
      const $ = (sel) => document.querySelector(sel);
      console.log('$ function works');
      const baseUrlInput = $("#baseUrl");
      console.log('baseUrlInput:', baseUrlInput);
      return 'ok';
    } catch (e) {
      return 'Error: ' + e.message;
    }
  });
  console.log('Eval result:', result);
  
  await browser.close();
})();