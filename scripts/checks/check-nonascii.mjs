import fs from 'fs';
const html = fs.readFileSync('src/ui/index.html', 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (scriptMatch) {
  const script = scriptMatch[1];
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i);
    if (code > 127) {
      const before = script.substring(0, i);
      const singleQuotes = (before.match(/'/g) || []).length;
      const doubleQuotes = (before.match(/"/g) || []).length;
      const backticks = (before.match(/`/g) || []).length;
      const inString = (singleQuotes % 2 === 1) || (doubleQuotes % 2 === 1) || (backticks % 2 === 1);
      const lastNewline = before.lastIndexOf('\n');
      const lineStart = before.substring(lastNewline + 1);
      const inComment = lineStart.includes('//');
      if (!inString && !inComment) {
        console.log('Non-ASCII outside string/comment at', i, ':', script[i], 'code:', code.toString(16), 'context:', script.substring(Math.max(0,i-30), i+30));
      }
    }
  }
}