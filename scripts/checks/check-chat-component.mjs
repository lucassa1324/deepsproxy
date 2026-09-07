import fs from 'fs';
const html = fs.readFileSync('src/ui/components/chat-component.js', 'utf8');
const lines = html.split('\n');
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (/[^\x00-\x7F]/.test(line)) {
    const before = lines.slice(0, i).join('\n');
    const singleQuotes = (before.match(/'/g) || []).length;
    const doubleQuotes = (before.match(/"/g) || []).length;
    const backticks = (before.match(/`/g) || []).length;
    const inString = (singleQuotes % 2 === 1) || (doubleQuotes % 2 === 1) || (backticks % 2 === 1);
    const lineStart = line.trim();
    const inComment = lineStart.startsWith('//') || lineStart.startsWith('*') || lineStart.startsWith('/*');
    if (!inString && !inComment) {
      console.log('Line', i+1, ':', line.substring(0, 150));
    }
  }
}