(function(){
  const $ = (id)=>document.getElementById(id);
  const btnStart=$('btnDebugStart'), btnStop=$('btnDebugStop'), btnClear=$('btnDebugClear');
  const status=$('debugStatus'), stateText=$('debugStateText'), startedAtEl=$('debugStartedAt'), durationEl=$('debugDuration'), countEl=$('debugCount');
  const feed=$('debugFeed'), autoScroll=$('debugAutoScroll');
  const btnCopyJson=$('btnDebugCopyJson'), btnCopyReport=$('btnDebugCopyReport'), btnDownload=$('btnDebugDownloadJson');
  const rptSession=$('debugRptSession'), rptDur=$('debugRptDur'), rptTotal=$('debugRptTotal'), rptErrors=$('debugRptErrors'), rptRouting=$('debugRptRouting'), rptModels=$('debugRptModels');
  const rptText=$('debugRptText'), rptJson=$('debugRptJson');
  let poll=null, startedAt=null, lastReportJson=null;

  function fmtTime(ts){ if(!ts)return '-'; try{return new Date(ts).toLocaleString();}catch(e){return String(ts);}}
  function fmtDur(ms){ if(ms==null)return '-'; const s=Math.floor(ms/1000); const m=Math.floor(s/60); const ss=s%60; if(m)return m+'m '+ss+'s'; return ss+'s';}

  function renderStatus(running){
    if(!status)return;
    if(running){
      status.classList.add('ok');
      var dot=status.querySelector('.dot'); if(dot) dot.style.background='rgba(120,220,160,.9)';
      if(status.childNodes[1]) status.childNodes[1].textContent=' GRAVANDO';
      if(stateText) stateText.textContent='Gravando...';
      if(btnStart) btnStart.disabled=true;
      if(btnStop) btnStop.disabled=false;
    }else{
      status.classList.remove('ok');
      var dot2=status.querySelector('.dot'); if(dot2) dot2.style.background='rgba(200,200,200,.6)';
      if(status.childNodes[1]) status.childNodes[1].textContent=' PARADO';
      if(stateText) stateText.textContent='Parado';
      if(btnStart) btnStart.disabled=false;
      if(btnStop) btnStop.disabled=true;
    }
  }

  function renderFeed(events){
    if(!feed) return;
    if(!events || events.length===0){ feed.innerHTML='<div class="debug-empty">Nenhum evento ainda. Inicie a captura e comece a usar o proxy.</div>'; return; }
    feed.innerHTML='';
    for(var i=events.length-1;i>=0;i--){
      var ev=events[i];
      var div=document.createElement('div');
      var cls='debug-item';
      if(ev.type==='provider:error' || (ev.status&&ev.status>=400) || ev.error) cls+=' err';
      else if(ev.type==='provider:success' || (ev.status&&ev.status>=200&&ev.status<300)) cls+=' ok';
      else if(ev.type==='router:decision' || ev.type==='orchestrator:decision') cls+=' warn';
      div.className=cls;
      var time=new Date(ev.ts).toLocaleTimeString();
      var title=ev.type;
      if(ev.type==='request:start') title='[REQ] Início';
      if(ev.type==='router:decision') title='[ROUTER] Decisão';
      if(ev.type==='orchestrator:decision') title='[ORCH] Decisão';
      if(ev.type==='provider:attempt') title='[PROV] Tentativa';
      if(ev.type==='provider:success') title='[PROV] Sucesso';
      if(ev.type==='provider:error') title='[PROV] Erro';
      if(ev.type==='rotation:used') title='[ROT] Rotação';
      if(ev.type==='request:end') title='[REQ] Fim';
      var tags=[];
      if(ev.usedOrchestrator) tags.push('<span class="tag warn">orquestrador</span>');
      if(ev.modelSelected && ev.modelRequested && ev.modelSelected!==ev.modelRequested) tags.push('<span class="tag info">roteado</span>');
      if(ev.status) tags.push('<span class="tag '+(ev.status>=400?'err':(ev.status>=200?'ok':''))+'">HTTP '+ev.status+'</span>');
      if(ev.latencyMs!=null) tags.push('<span class="tag">⏱ '+ev.latencyMs+'ms</span>');
      var html='<div class="debug-head"><div class="debug-title">'+title+'</div><div class="debug-meta"><span>'+time+'</span><span>req:'+(ev.requestId||'-')+'</span></div></div><div class="debug-tags">'+tags.join('')+'</div><div class="debug-grid">';
      if(ev.modelRequested) html+='<div class="debug-kv"><div class="debug-k">solicitado</div><div class="debug-v">'+ev.modelRequested+'</div></div>';
      if(ev.modelSelected) html+='<div class="debug-kv"><div class="debug-k">escolhido</div><div class="debug-v">'+ev.modelSelected+'</div></div>';
      if(ev.strategy) html+='<div class="debug-kv"><div class="debug-k">estratégia</div><div class="debug-v">'+ev.strategy+'</div></div>';
      if(ev.reason) html+='<div class="debug-kv"><div class="debug-k">motivo</div><div class="debug-v">'+ev.reason+'</div></div>';
      if(ev.provider) html+='<div class="debug-kv"><div class="debug-k">provedor</div><div class="debug-v">'+ev.provider+'</div></div>';
      if(ev.keyLabel) html+='<div class="debug-kv"><div class="debug-k">chave</div><div class="debug-v">'+ev.keyLabel+'</div></div>';
      if(ev.attempt) html+='<div class="debug-kv"><div class="debug-k">tentativa</div><div class="debug-v">'+ev.attempt+'</div></div>';
      if(ev.appName) html+='<div class="debug-kv"><div class="debug-k">app/gateway</div><div class="debug-v">'+ev.appName+'</div></div>';
      html+='</div>';
      if(ev.error) html+='<div class="debug-err">'+String(ev.error).replace(/</g,'&lt;')+'</div>';
      div.innerHTML=html;
      feed.appendChild(div);
    }
    if(autoScroll && autoScroll.checked) feed.scrollTop=0;
  }

  async function refresh(){
    try{
      var r=await fetch('/api/debug/status');
      var j=await r.json();
      renderStatus(j.running);
      if(countEl) countEl.textContent=j.session?j.session.count:'0';
      if(j.session && j.session.startedAt){ startedAt=j.session.startedAt; if(startedAtEl) startedAtEl.textContent=fmtTime(startedAt); if(durationEl) durationEl.textContent=fmtDur(Date.now()-startedAt); }
      renderFeed(j.events||[]);
    }catch(e){}
  }

  if(btnStart) btnStart.addEventListener('click', async function(){
    try{
      var r=await fetch('/api/debug/start',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      var j=await r.json();
      if(j.ok){ startedAt=j.session.startedAt; if(startedAtEl) startedAtEl.textContent=fmtTime(startedAt); renderStatus(true); refresh(); if(poll)clearInterval(poll); poll=setInterval(refresh,1500); }
    }catch(e){ alert('Erro ao iniciar captura'); }
  });

  if(btnStop) btnStop.addEventListener('click', async function(){
    try{
      var r=await fetch('/api/debug/stop',{method:'POST'});
      var j=await r.json();
      if(poll){ clearInterval(poll); poll=null; }
      renderStatus(false);
      if(j.ok && j.report){
        lastReportJson=JSON.stringify(j.report,null,2);
        if(rptSession) rptSession.textContent=j.session?j.session.id:'-';
        if(rptDur) rptDur.textContent=fmtDur((j.session.stoppedAt-j.session.startedAt));
        if(rptTotal) rptTotal.textContent=j.report.summary.totalRequests;
        if(rptErrors) rptErrors.textContent=j.report.summary.errorsOrFailures;
        if(rptRouting) rptRouting.textContent='orc:'+j.report.summary.usedOrchestratorCount+' / roteador:'+j.report.summary.usedRouterOnly;
        if(rptModels) rptModels.textContent=(j.report.summary.modelsUsed||[]).map(function(x){return x[0]+'('+x[1]+')';}).join(', ');
        if(rptText) rptText.value=j.text||'';
        if(rptJson) rptJson.value=lastReportJson;
      }else if(j.error){ alert(j.error); }
      refresh();
    }catch(e){ alert('Erro ao parar captura'); }
  });

  if(btnClear) btnClear.addEventListener('click', async function(){
    try{
      await fetch('/api/debug/clear',{method:'POST'});
      if(feed) feed.innerHTML='<div class="debug-empty">Feed limpo.</div>';
      if(countEl) countEl.textContent='0';
      if(rptText) rptText.value='';
      if(rptJson) rptJson.value='';
      lastReportJson=null;
    }catch(e){}
  });

  if(btnCopyJson) btnCopyJson.addEventListener('click', async function(){
    var txt=(rptJson && rptJson.value)?rptJson.value:(lastReportJson||'');
    if(!txt){ alert('Nenhum relatório ainda. Pare a captura para gerar.'); return; }
    try{ await navigator.clipboard.writeText(txt); btnCopyJson.textContent='Copiado!'; setTimeout(function(){btnCopyJson.textContent='Copiar JSON completo';},1200); }catch(e){ alert('Falha ao copiar'); }
  });

  if(btnCopyReport) btnCopyReport.addEventListener('click', async function(){
    var txt=(rptText && rptText.value)?rptText.value:'';
    if(!txt){ alert('Nenhum relatório ainda. Pare a captura para gerar.'); return; }
    try{ await navigator.clipboard.writeText(txt); btnCopyReport.textContent='Copiado!'; setTimeout(function(){btnCopyReport.textContent='Copiar relatório pronto p/ análise';},1200); }catch(e){ alert('Falha ao copiar'); }
  });

  if(btnDownload) btnDownload.addEventListener('click', function(){
    var txt=(rptJson && rptJson.value)?rptJson.value:(lastReportJson||'');
    if(!txt){ alert('Nenhum relatório ainda. Pare a captura para gerar.'); return; }
    var blob=new Blob([txt],{type:'application/json'});
    var url=URL.createObjectURL(blob);
    var a=document.createElement('a'); a.href=url; a.download='debug-session.json'; a.click(); URL.revokeObjectURL(url);
  });

  setInterval(function(){ if(startedAt && btnStop && !btnStop.disabled && durationEl){ durationEl.textContent=fmtDur(Date.now()-startedAt); } }, 1000);
  refresh();
})();
