(function(){
  const $ = (id)=>document.getElementById(id);
  const skillsList = $('storeSkillsList');
  const mcpsList = $('storeMcpsList');
  const btnReload = $('btnStoreReload');
  const btnAi = $('btnStoreAiConfig');
  const aiPanel = $('storeAiPanel');
  const aiPrompt = $('storeAiPrompt');
  const btnCopyAi = $('btnStoreCopyAiPrompt');
  const skillSearch = $('storeSkillSearch');
  const skillFilter = $('storeSkillFilter');
  const mcpSearch = $('storeMcpSearch');
  const mcpFilter = $('storeMcpFilter');
  let catalog = { skills: [], mcps: [] };

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  async function post(url, body){ const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}); return r.json(); }

  async function load(){
    try{ const r = await fetch('/api/store/catalog'); const j = await r.json(); if(j.ok){ catalog = j; render(); } }
    catch(e){ if(skillsList) skillsList.innerHTML='<div class="note">Erro ao carregar catálogo.</div>'; }
  }
  function render(){ renderSkills(); renderMcps(); }

  function renderSkills(){
    if(!skillsList) return;
    const q = ((skillSearch && skillSearch.value) || '').toLowerCase().trim();
    const cat = (skillFilter && skillFilter.value) || '';
    const items = (catalog.skills||[]).filter(s=>{
      if(cat && s.category!==cat) return false;
      if(!q) return true;
      const hay = (s.name+' '+s.description+' '+(s.tags||[]).join(' ')+' '+s.id+' '+(s.source||'')).toLowerCase();
      return hay.includes(q);
    });
    if(!items.length){ skillsList.innerHTML='<div class="note">Nenhuma skill encontrada.</div>'; return; }
    skillsList.innerHTML = items.map(s=>{
      const inst = s.installedState;
      const enabled = inst && inst.enabled;
      const scope = inst ? inst.scope : (s.scopeHint==='3005'||s.scopeHint==='3006'?s.scopeHint:'both');
      const status = s.installed ? (enabled?'<span class="tag ok">ATIVA</span>':'<span class="tag">instalada (off)</span>') : '<span class="tag">catálogo</span>';
      const srcTag = s.source==='custom' ? '<span class="tag info">custom</span>' : (s.source==='community' ? '<span class="tag info">comunidade</span>' : '');
      const canDeleteCustom = s.source==='custom';
      return `<div class="debug-item" style="margin:0;background:rgba(255,255,255,.02);">
        <div class="row" style="justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">
          <div style="flex:1;min-width:240px;">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;"><strong>${esc(s.name)}</strong> ${status} ${srcTag} <span class="tag">${esc(s.category)}</span> ${s.recommended?'<span class="tag warn">recomendada</span>':''}</div>
            <div class="hint" style="margin-top:4px;">${esc(s.description||'')}</div>
            <div class="hint" style="margin-top:2px;">Escopo (3005 direta / 3006 gateway): <strong>${esc(scope)}</strong>${s.repoUrl?` · <a href="${esc(s.repoUrl)}" target="_blank" rel="noreferrer">fonte</a>`:''}</div>
          </div>
          <div class="row" style="gap:6px;flex-wrap:wrap;">
            ${!s.installed ? `<button class="btn" data-act="skill-install" data-id="${esc(s.id)}">Usar</button>` : `
              <button class="btn ghost" data-act="skill-toggle" data-id="${esc(s.id)}" data-enabled="${enabled?1:0}">${enabled?'Desativar':'Ativar'}</button>
              <select data-act="skill-scope" data-id="${esc(s.id)}" title="Escopo">
                <option value="both" ${scope==='both'?'selected':''}>3005+3006</option>
                <option value="3005" ${scope==='3005'?'selected':''}>Só 3005</option>
                <option value="3006" ${scope==='3006'?'selected':''}>Só 3006</option>
              </select>
              <button class="btn ghost danger" data-act="skill-uninstall" data-id="${esc(s.id)}">Remover uso</button>
            `}
            <button class="btn ghost" data-act="skill-view" data-id="${esc(s.id)}">Instruções</button>
            ${canDeleteCustom ? `<button class="btn ghost danger" data-act="skill-delete-custom" data-id="${esc(s.id)}">Excluir custom</button>`:''}
          </div>
        </div>
        <div id="skill-view-${esc(s.id)}" style="display:none;margin-top:8px;"><pre style="white-space:pre-wrap;background:rgba(0,0,0,.25);padding:10px;border-radius:8px;max-height:240px;overflow:auto;font-size:12px;">${esc((inst&&inst.instructions)||s.instructions||'')}</pre></div>
      </div>`;
    }).join('');
  }

  function renderMcps(){
    if(!mcpsList) return;
    const q = ((mcpSearch && mcpSearch.value) || '').toLowerCase().trim();
    const cat = (mcpFilter && mcpFilter.value) || '';
    const items = (catalog.mcps||[]).filter(m=>{
      if(cat && m.category!==cat) return false;
      if(!q) return true;
      const hay = (m.name+' '+m.description+' '+(m.tags||[]).join(' ')+' '+m.id+' '+(m.source||'')).toLowerCase();
      return hay.includes(q);
    });
    if(!items.length){ mcpsList.innerHTML='<div class="note">Nenhum MCP encontrado.</div>'; return; }
    mcpsList.innerHTML = items.map(m=>{
      const inst = m.installedState;
      const cfg = (inst && inst.config) || m.config || {};
      const srcTag = m.source==='custom' ? '<span class="tag info">custom</span>' : (m.repoUrl ? '<span class="tag">popular</span>' : '');
      const canDeleteCustom = m.source==='custom';
      return `<div class="debug-item" style="margin:0;background:rgba(255,255,255,.02);">
        <div class="row" style="justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">
          <div style="flex:1;min-width:240px;">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;"><strong>${esc(m.name)}</strong> ${m.installed?'<span class="tag ok">SALVO</span>':'<span class="tag">catálogo</span>'} ${srcTag} <span class="tag">${esc(m.category)}</span></div>
            <div class="hint" style="margin-top:4px;">${esc(m.description||'')}</div>
            ${m.notes?`<div class="hint" style="margin-top:2px;">Nota: ${esc(m.notes)}</div>`:''}
            ${m.repoUrl?`<div class="hint" style="margin-top:2px;"><a href="${esc(m.repoUrl)}" target="_blank" rel="noreferrer">Repositório/fonte</a></div>`:''}
          </div>
          <div class="row" style="gap:6px;flex-wrap:wrap;">
            ${!m.installed ? `<button class="btn" data-act="mcp-install" data-id="${esc(m.id)}">Salvar</button>` : `<button class="btn ghost danger" data-act="mcp-uninstall" data-id="${esc(m.id)}">Remover</button>`}
            <button class="btn ghost" data-act="mcp-copy" data-id="${esc(m.id)}">Copiar config</button>
            <button class="btn ghost" data-act="mcp-view" data-id="${esc(m.id)}">Ver config</button>
            ${canDeleteCustom ? `<button class="btn ghost danger" data-act="mcp-delete-custom" data-id="${esc(m.id)}">Excluir custom</button>`:''}
          </div>
        </div>
        <div id="mcp-view-${esc(m.id)}" style="display:none;margin-top:8px;"><pre style="white-space:pre-wrap;background:rgba(0,0,0,.25);padding:10px;border-radius:8px;max-height:260px;overflow:auto;font-size:12px;">${esc(JSON.stringify(cfg,null,2))}</pre></div>
      </div>`;
    }).join('');
  }

  document.addEventListener('click', async (e)=>{
    const btn = e.target.closest('[data-act]');
    if(btn){
      const act = btn.getAttribute('data-act');
      const id = btn.getAttribute('data-id');
      try{
        if(act==='skill-install'){ await post('/api/store/skills/install',{id, enabled:true}); await load(); }
        else if(act==='skill-uninstall'){ await post('/api/store/skills/uninstall',{id}); await load(); }
        else if(act==='skill-toggle'){ const en = btn.getAttribute('data-enabled')!=='1'; await post('/api/store/skills/update',{id, enabled:en}); await load(); }
        else if(act==='skill-view'){ const el=$('skill-view-'+id); if(el) el.style.display = el.style.display==='none'?'block':'none'; }
        else if(act==='skill-delete-custom'){ if(confirm('Excluir esta skill custom?')){ await post('/api/store/skills/delete-custom',{id}); await load(); } }
        else if(act==='mcp-install'){ await post('/api/store/mcps/install',{id, enabled:true}); await load(); }
        else if(act==='mcp-uninstall'){ await post('/api/store/mcps/uninstall',{id}); await load(); }
        else if(act==='mcp-view'){ const el=$('mcp-view-'+id); if(el) el.style.display = el.style.display==='none'?'block':'none'; }
        else if(act==='mcp-delete-custom'){ if(confirm('Excluir este MCP custom?')){ await post('/api/store/mcps/delete-custom',{id}); await load(); } }
        else if(act==='mcp-copy'){
          const m = (catalog.mcps||[]).find(x=>x.id===id);
          const cfg = (m && m.installedState && m.installedState.config) || (m && m.config) || {};
          await navigator.clipboard.writeText(JSON.stringify(cfg,null,2));
          btn.textContent='Copiado!'; setTimeout(()=>btn.textContent='Copiar config',1200);
        }
      }catch(err){ console.error(err); }
      return;
    }
  });

  document.addEventListener('change', async (e)=>{
    const sel = e.target.closest('[data-act="skill-scope"]');
    if(sel){ await post('/api/store/skills/update',{id: sel.getAttribute('data-id'), scope: sel.value}); await load(); }
    if(e.target===skillFilter) renderSkills();
    if(e.target===mcpFilter) renderMcps();
  });
  if(skillSearch) skillSearch.addEventListener('input', renderSkills);
  if(mcpSearch) mcpSearch.addEventListener('input', renderMcps);
  if(btnReload) btnReload.addEventListener('click', load);
  if(btnAi) btnAi.addEventListener('click', async ()=>{ try{ const r = await post('/api/store/ai-configure',{}); if(r.ok && aiPrompt){ aiPrompt.value=r.prompt||''; if(aiPanel) aiPanel.style.display='block'; aiPanel.scrollIntoView({behavior:'smooth'}); } }catch(e){} });
  if(btnCopyAi) btnCopyAi.addEventListener('click', async ()=>{ if(!aiPrompt||!aiPrompt.value) return; try{ await navigator.clipboard.writeText(aiPrompt.value); btnCopyAi.textContent='Copiado!'; setTimeout(()=>btnCopyAi.textContent='Copiar prompt',1200);}catch(e){} });

  // Custom forms
  const btnAddSkill=$('btnAddCustomSkill'), formSkill=$('customSkillForm'), btnSaveSkill=$('btnSaveCustomSkill'), btnCancelSkill=$('btnCancelCustomSkill');
  const btnAddMcp=$('btnAddCustomMcp'), formMcp=$('customMcpForm'), btnSaveMcp=$('btnSaveCustomMcp'), btnCancelMcp=$('btnCancelCustomMcp');
  if(btnAddSkill) btnAddSkill.addEventListener('click', ()=>{ if(formSkill) formSkill.style.display=formSkill.style.display==='none'?'block':'none'; });
  if(btnCancelSkill) btnCancelSkill.addEventListener('click', ()=>{ if(formSkill) formSkill.style.display='none'; });
  if(btnSaveSkill) btnSaveSkill.addEventListener('click', async ()=>{
    const name=($('csName')||{}).value, description=($('csDesc')||{}).value, category=($('csCat')||{}).value, instructions=($('csInstr')||{}).value;
    if(!name||!instructions){ alert('Nome e instruções são obrigatórios.'); return; }
    const r=await post('/api/store/skills/create',{name,description,category,instructions,scopeHint:'both',tags:[category||'custom']});
    if(r.ok){ if(formSkill) formSkill.style.display='none'; if($('csName'))$('csName').value=''; if($('csDesc'))$('csDesc').value=''; if($('csInstr'))$('csInstr').value=''; await load(); }
    else alert(r.error||'Erro ao salvar');
  });
  if(btnAddMcp) btnAddMcp.addEventListener('click', ()=>{ if(formMcp) formMcp.style.display=formMcp.style.display==='none'?'block':'none'; });
  if(btnCancelMcp) btnCancelMcp.addEventListener('click', ()=>{ if(formMcp) formMcp.style.display='none'; });
  if(btnSaveMcp) btnSaveMcp.addEventListener('click', async ()=>{
    const name=($('cmName')||{}).value, description=($('cmDesc')||{}).value, category=($('cmCat')||{}).value, cfgText=($('cmConfig')||{}).value;
    if(!name||!cfgText){ alert('Nome e config JSON são obrigatórios.'); return; }
    let config; try{ config=JSON.parse(cfgText); }catch(e){ alert('Config JSON inválido'); return; }
    const r=await post('/api/store/mcps/create',{name,description,category,config,tags:[category||'custom']});
    if(r.ok){ if(formMcp) formMcp.style.display='none'; if($('cmName'))$('cmName').value=''; if($('cmDesc'))$('cmDesc').value=''; if($('cmConfig'))$('cmConfig').value=''; await load(); }
    else alert(r.error||'Erro ao salvar');
  });

  load();
})();


  // Mass import
  const btnImport=$('btnStoreImport'), importJson=$('storeImportJson'), importSrc=$('storeImportSource'), importStatus=$('storeImportStatus');
  if(btnImport) btnImport.addEventListener('click', async ()=>{
    if(!importJson||!importJson.value.trim()){ if(importStatus) importStatus.textContent='Cole um JSON.'; return; }
    let payload; try{ payload=JSON.parse(importJson.value); }catch(e){ if(importStatus) importStatus.textContent='JSON inválido'; return; }
    payload.source = (importSrc&&importSrc.value)||'custom';
    if(importStatus) importStatus.textContent='Importando...';
    try{ const r=await post('/api/store/import', payload); if(importStatus) importStatus.textContent = r.ok ? ('Importado: '+(r.importedSkills||0)+' skills, '+(r.importedMcps||0)+' MCPs'+(r.errors&&r.errors.length?(' · avisos: '+r.errors.slice(0,2).join('; ')):'') ) : ('Erro: '+(r.error||(r.errors||[]).join('; '))); if(r.ok||((r.importedSkills||0)+(r.importedMcps||0))>0) await load(); }catch(e){ if(importStatus) importStatus.textContent='Falha: '+e.message; }
  });
