const html = await (await fetch('http://localhost:3005/')).text();
const start = html.indexOf('<script>');
const end = html.indexOf('</script>');
if (start >= 0 && end >= 0) {
  const script = html.substring(start + 8, end);
  const lines = script.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Check for non-ASCII outside strings
    if (/[^\x00-\x7F]/.test(line)) {
      // Simple check: count quotes before this line
      const before = lines.slice(0, i).join('\n');
      const singleQuotes = (before.match(/'/g) || []).length;
      const doubleQuotes = (before.match(/"/g) || []).length;
      const backticks = (before.match(/`/g) || []).length;
      const inString = (singleQuotes % 2 === 1) || (doubleQuotes % 2 === 1) || (backticks % 2 === 1);
      const lineStart = line.trim();
      const inComment = lineStart.startsWith('//');
      if (!inString && !inComment) {
        console.log('Line', i+1, ':', line.substring(0, 150));
      }
    }
  }
}