import fs from 'fs';
const html = fs.readFileSync('src/ui/index.html', 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (scriptMatch) {
  const script = scriptMatch[1];
  const body = script.replace(/^\(function \(\) \{\s*"use strict";\s*/, '').replace(/\s*\}\)\(\);\s*$/, '');
  const lines = body.split('\n');
  for (let i = 1820; i < 1840; i++) {
    console.log('Line', i+1, ':', lines[i]);
  }
}