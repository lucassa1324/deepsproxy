const html = await (await fetch('http://localhost:3005/components/chat-component.js')).text();
const lines = html.split('\n');
console.log('Total lines:', lines.length);
for (let i = 1435; i < 1455; i++) {
  console.log('Line', i+1, ':', lines[i]);
}