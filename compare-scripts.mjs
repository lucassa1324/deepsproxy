import fs from 'fs';
const sourceHtml = fs.readFileSync('src/ui/index.html', 'utf8');
const scriptMatch = sourceHtml.match(/<script>([\s\S]*?)<\/script>/);
const sourceScript = scriptMatch ? scriptMatch[1] : '';

const servedHtml = await (await fetch('http://localhost:3005/')).text();
const start = servedHtml.indexOf('<script>');
const end = servedHtml.indexOf('</script>');
const servedScript = servedHtml.substring(start + 8, end);

console.log('Source length:', sourceScript.length);
console.log('Served length:', servedScript.length);
console.log('Match:', sourceScript === servedScript);
if (sourceScript !== servedScript) {
  for (let i = 0; i < Math.min(sourceScript.length, servedScript.length); i++) {
    if (sourceScript[i] !== servedScript[i]) {
      console.log('First diff at', i);
      console.log('Source:', sourceScript.substring(i, i+50));
      console.log('Served:', servedScript.substring(i, i+50));
      break;
    }
  }
}