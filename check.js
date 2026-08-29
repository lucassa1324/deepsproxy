fetch('http://localhost:3005/').then(r=>r.text()).then(html=>{
  const scripts = html.match(/<script[^>]*src=['"]([^'"]+)['"]/g) || [];
  console.log('External scripts:', scripts);
  const inlineScripts = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
  console.log('Inline scripts count:', inlineScripts.length);
  console.log('First inline script length:', inlineScripts[0]?.length);
});