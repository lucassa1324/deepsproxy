import fs from 'fs';
const html = fs.readFileSync('src/ui/index.html', 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (scriptMatch) {
  const script = scriptMatch[1];
  const body = script.replace(/^\(function \(\) \{\s*"use strict";\s*/, '').replace(/\s*\}\)\(\);\s*$/, '');
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(':') && !line.trim().startsWith('//')) {
      const trimmed = line.trim();
      // Check for label statements (identifier: statement) not in object context
      // Object context: line contains = { or line starts with { or previous line has {
      if (/^[a-zA-Z_$][\w$]*\s*:/.test(trimmed) && !trimmed.includes('=') && !trimmed.includes('{') && !trimmed.includes('}') && !trimmed.includes('(') && !trimmed.includes('?') && !trimmed.includes('return') && !trimmed.endsWith(',') && !trimmed.includes('=>')) {
        // Check if we're in an object by looking at previous lines
        let inObject = false;
        for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
          if (lines[j].includes('{') && !lines[j].includes('}')) {
            inObject = true;
            break;
          }
          if (lines[j].includes('}')) break;
        }
        if (!inObject) {
          console.log('Line', i+1, '(possible label stmt):', line.substring(0, 150));
        }
      }
    }
  }
}