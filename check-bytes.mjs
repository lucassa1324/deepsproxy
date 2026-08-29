const res = await fetch('http://localhost:3005/');
const buf = await res.arrayBuffer();
const bytes = new Uint8Array(buf);
// Find the script tag
const html = new TextDecoder().decode(bytes);
const start = html.indexOf('<script>');
const end = html.indexOf('</script>');
if (start >= 0 && end >= 0) {
  const script = html.substring(start + 8, end);
  // Check raw bytes around where the error might be
  // "Unexpected token ':'" - look for colons that might be problematic
  const scriptBytes = new TextEncoder().encode(script);
  for (let i = 0; i < scriptBytes.length; i++) {
    if (scriptBytes[i] === 0x3A) { // colon
      // Check if previous byte is non-ASCII
      if (i > 0 && scriptBytes[i-1] > 127) {
        console.log('Colon after non-ASCII at byte', i, ':', String.fromCharCode(scriptBytes[i-1]), scriptBytes[i-1].toString(16));
        console.log('Context:', new TextDecoder().decode(scriptBytes.subarray(Math.max(0, i-30), i+30)));
      }
    }
  }
}