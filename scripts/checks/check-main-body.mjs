import fs from 'fs';
const html = fs.readFileSync('src/ui/index.html', 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (scriptMatch) {
  const script = scriptMatch[1];
  const body = script.replace(/^\(function \(\) \{\s*"use strict";\s*/, '').replace(/\s*\}\)\(\);\s*$/, '');
  console.log('Body length:', body.length);
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(':') && !line.trim().startsWith('//')) {
      const trimmed = line.trim();
      if (/^[a-zA-Z_$][\w$]*\s*:/.test(trimmed) && !trimmed.includes('=') && !trimmed.includes('{') && !trimmed.includes('}') && !trimmed.includes('(') && !trimmed.includes('?') && !trimmed.includes('return')) {
        console.log('Line', i+1, ':', line.substring(0, 150));
      }
    }
  }
}