const res = await fetch('http://localhost:3005/');
const buf = await res.arrayBuffer();
const bytes = new Uint8Array(buf);
const html = new TextDecoder().decode(bytes);
// Check the area around the two script tags
console.log('Around first script end:');
console.log(html.substring(202700, 202900));