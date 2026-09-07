const html = await (await fetch('http://localhost:3005/')).text();
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (match) {
  const script = match[1];
  console.log('Script length:', script.length);
  // Check for any non-ASCII characters
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i);
    if (code > 127) {
      console.log('Non-ASCII at', i, ':', script[i], 'code:', code, 'context:', script.substring(Math.max(0,i-10), i+10));
    }
  }
}