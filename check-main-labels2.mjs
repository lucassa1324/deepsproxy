import fs from 'fs';
const html = fs.readFileSync('src/ui/index.html', 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (scriptMatch) {
  const script = scriptMatch[1];
  // Extract the function body (remove IIFE wrapper)
  const body = script.replace(/^\(function \(\) \{\s*"use strict";\s*/, '').replace(/\s*\}\)\(\);\s*$/, '');
  console.log('Body length:', body.length);
  
  // Try to parse with acorn if available, or check for common issues
  // Check for any ':' that might be problematic
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Check for potential issues: label statements not in object context
    if (line.includes(':') && !line.trim().startsWith('//')) {
      const trimmed = line.trim();
      // Check for label: statement pattern
      if (/^[a-zA-Z_$][\w$]*\s*:/.test(trimmed)) {
        // Check if it's in an object literal
        const isInObject = trimmed.endsWith(',') || trimmed.includes('=>') || trimmed.includes('{') || trimmed.includes('}');
        if (!isInObject) {
          // Check context by looking at surrounding lines
          let inObject = false;
          for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
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
}