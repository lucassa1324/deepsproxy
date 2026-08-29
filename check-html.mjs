import fs from 'fs';
const html = fs.readFileSync('src/ui/index.html', 'utf8');
let pos = 0;
while (true) {
  const start = html.indexOf('<script', pos);
  if (start === -1) break;
  const end = html.indexOf('</script>', start);
  if (end === -1) {
    console.log('Unclosed script tag at', start);
    break;
  }
  const scriptTag = html.substring(start, end + 9);
  const typeMatch = scriptTag.match(/type=['"]([^'"]+)['"]/);
  const srcMatch = scriptTag.match(/src=['"]([^'"]+)['"]/);
  console.log('Script tag at', start, 'type:', typeMatch ? typeMatch[1] : 'inline', 'src:', srcMatch ? srcMatch[1] : 'none');
  pos = end + 9;
}