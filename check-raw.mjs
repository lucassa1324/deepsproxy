const res = await fetch('http://localhost:3005/');
const buf = await res.arrayBuffer();
const bytes = new Uint8Array(buf);
// Check first 10 bytes
console.log('First 10 bytes:', Array.from(bytes.subarray(0, 10)).map(b => '0x' + b.toString(16).padStart(2, '0')));
// Check for BOM
console.log('Has BOM:', bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF);
// Check for script tag bytes
const html = new TextDecoder().decode(bytes);
const scriptStart = html.indexOf('<script>');
console.log('Script tag at char:', scriptStart);
console.log('Bytes at script tag:', Array.from(bytes.subarray(scriptStart, scriptStart + 20)).map(b => '0x' + b.toString(16).padStart(2, '0')));