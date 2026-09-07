const html = await (await fetch('http://localhost:3005/components/chat-component.js')).text();
console.log('Chat component length:', html.length);
console.log('First 200 chars:', html.substring(0, 200));
console.log('---');
console.log('Last 200 chars:', html.substring(html.length - 200));