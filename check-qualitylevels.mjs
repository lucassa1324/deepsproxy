const html = await (await fetch('http://localhost:3005/')).text();
const start = html.indexOf('<script>');
const end = html.indexOf('</script>');
if (start >= 0 && end >= 0) {
  const script = html.substring(start + 8, end);
  let idx = 0;
  while ((idx = script.indexOf('qualityLevels', idx)) !== -1) {
    console.log('Found at', idx);
    console.log(script.substring(idx, idx + 80));
    idx += 15;
  }
}