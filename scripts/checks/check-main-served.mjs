const html = await (await fetch('http://localhost:3005/')).text();
const start = html.indexOf('<script>');
const end = html.indexOf('</script>');
if (start >= 0 && end >= 0) {
  const script = html.substring(start + 8, end);
  console.log('Served first 100:', script.substring(0, 100));
  console.log('Served length:', script.length);
}