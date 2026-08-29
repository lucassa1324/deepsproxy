const html = await (await fetch('http://localhost:3005/')).text();
const start = html.indexOf('<script>');
const end = html.indexOf('</script>');
if (start >= 0 && end >= 0) {
  const script = html.substring(start + 8, end);
  const lines = script.split('\n');
  // Check line 2106 area
  for (let i = 2100; i < 2120; i++) {
    console.log('Line', i+1, ':', lines[i]?.substring(0, 150));
  }
}