const html = await (await fetch('http://localhost:3005/')).text();
const start = html.indexOf('<script>');
const end = html.indexOf('</script>');
if (start >= 0 && end >= 0) {
  const script = html.substring(start + 8, end);
  console.log('Script length:', script.length);
  console.log('First 200 chars:');
  console.log(script.substring(0, 200));
  console.log('---');
  console.log('Last 200 chars:');
  console.log(script.substring(script.length - 200));
}