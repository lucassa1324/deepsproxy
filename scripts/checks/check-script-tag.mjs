const res = await fetch('http://localhost:3005/');
const buf = await res.arrayBuffer();
const bytes = new Uint8Array(buf);
const html = new TextDecoder().decode(bytes);
// Find ALL script tags
let pos = 0;
while (true) {
  const idx = html.indexOf('<script', pos);
  if (idx === -1) break;
  console.log('Found <script at char:', idx);
  console.log('Context:', html.substring(idx, idx + 50));
  pos = idx + 7;
}
// Also check </script>
pos = 0;
while (true) {
  const idx = html.indexOf('</script>', pos);
  if (idx === -1) break;
  console.log('Found </script at char:', idx);
  pos = idx + 9;
}