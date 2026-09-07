const html = await (await fetch('http://localhost:3005/')).text();
const start = html.indexOf('<script>');
const end = html.indexOf('</script>');
if (start >= 0 && end >= 0) {
  const script = html.substring(start + 8, end);
  // Check for non-ASCII in object keys
  const lines = script.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Look for non-ASCII in identifier position before colon (not in strings/comments)
    if (/[^\x00-\x7F]/.test(line)) {
      // Check if it looks like an object key
      if (/[a-zA-Z_$][\w$]*[^\x00-\x7F][\w$]*\s*:/.test(line)) {
        // Check if it's in a string/comment
        const before = script.split('\n').slice(0, i).join('\n');
        const singleQuotes = (before.match(/'/g) || []).length;
        const doubleQuotes = (before.match(/"/g) || []).length;
        const backticks = (before.match(/`/g) || []).length;
        const inString = (singleQuotes % 2 === 1) || (doubleQuotes % 2 === 1) || (backticks % 2 === 1);
        const lastNewline = before.lastIndexOf('\n');
        const lineStart = before.substring(lastNewline + 1);
        const inComment = lineStart.includes('//');
        if (!inString && !inComment) {
          console.log('Line', i+1, ':', line.substring(0, 200));
        }
      }
    }
  }
}