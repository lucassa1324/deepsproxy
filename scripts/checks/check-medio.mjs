const html = await (await fetch('http://localhost:3005/')).text();
const start = html.indexOf('<script>');
const end = html.indexOf('</script>');
if (start >= 0 && end >= 0) {
  const script = html.substring(start + 8, end);
  const lines = script.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('médio') && !line.includes('"médio"') && !line.includes("'médio'")) {
      console.log('Line', i+1, ':', line.substring(0, 150));
    }
  }
}