const html = await (await fetch('http://localhost:3005/')).text();
const start = html.indexOf('<script>');
const end = html.indexOf('</script>');
if (start >= 0 && end >= 0) {
  const script = html.substring(start + 8, end);
  console.log('Char at 1628:', script[1628], 'code:', script.charCodeAt(1628));
  console.log('Context:', script.substring(1620, 1640));
  console.log('Char at 1789:', script[1789], 'code:', script.charCodeAt(1789));
  console.log('Context:', script.substring(1780, 1800));
}