'use strict';

const $ = s => document.querySelector(s);
const state = { csrf:'', catalog:null, selectedContact:null, drafts:[], user:null, adminProducts:[], employees:[], draftKey:newDraftKey() };

// Lokales Datum (Browser-Zeitzone) als 'YYYY-MM-DD'. toISOString() wäre UTC und liefert
// in der Schweiz zwischen 00:00 und 01:00/02:00 Uhr noch den Vortag.
function localIsoDate(d=new Date()){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
// 'YYYY-MM-DD' (oder ISO-Zeitstempel) als Schweizer Datum anzeigen, ohne Zeitzonen-Verschiebung.
function displayDate(v){
  const s=String(v||'').slice(0,10);
  const d=new Date(`${s}T12:00:00`);
  return Number.isNaN(d.getTime())?s:d.toLocaleDateString('de-CH');
}
// Eindeutiger Schlüssel pro erfasster Bestellung (Schutz gegen Doppelklick/Doppelsenden).
function newDraftKey(){
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  if (!window.crypto?.getRandomValues) return '';
  const b=window.crypto.getRandomValues(new Uint8Array(16));
  b[6]=(b[6]&0x0f)|0x40; b[8]=(b[8]&0x3f)|0x80;
  const h=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

async function api(url, options={}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body !== 'string') {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  if (state.csrf && ['POST','PUT','PATCH','DELETE'].includes((options.method||'GET').toUpperCase())) headers['x-csrf-token'] = state.csrf;
  const r = await fetch(url, { ...options, headers, credentials: 'same-origin' });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw new Error(data?.error || `Fehler ${r.status}`);
  return data;
}

function msg(el, text='', type='') { el.textContent = text; el.className = `msg ${type}`; }
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function qty(v){const n=Number(v);return Number.isFinite(n)?n.toLocaleString('de-CH',{maximumFractionDigits:6}):v}
function money(v){const n=Number(v);return Number.isFinite(n)?`CHF ${n.toLocaleString('de-CH',{minimumFractionDigits:2,maximumFractionDigits:2})}`:'Preis nicht hinterlegt'}

async function boot(){
  const setup = await api('/api/setup/status');
  if (setup.setupRequired) return showSetup();
  const s = await api('/api/session');
  if (!s.authenticated) return showLogin();
  state.csrf = s.csrf; state.user = s.user || null;
  $('#productAdminBtn').hidden = state.user?.role !== 'admin';
  $('#setupCard').hidden = true; $('#loginCard').hidden = true; $('#app').hidden = false;
  $('#modeBadge').textContent = s.dryRun ? 'TESTMODUS – keine bexio-Schreibzugriffe' : 'PRODUKTIV';
  $('#modeBadge').className = `badge ${s.dryRun?'warn':''}`;
  $('#deliveryDate').value = localIsoDate();
  await loadStatus();
  await loadDrafts();
}

function showSetup(){ $('#setupCard').hidden=false; $('#loginCard').hidden=true; $('#app').hidden=true; }
function showLogin(){ $('#setupCard').hidden=true; $('#loginCard').hidden=false; $('#app').hidden=true; }


$('#setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.currentTarget.querySelector('button[type="submit"]');
  btn.disabled = true;
  msg($('#setupMsg'), 'Admin-Konto wird erstellt …');
  try {
    await api('/api/setup', {
      method: 'POST',
      body: {
        username: $('#setupUsername').value,
        password: $('#setupPassword').value,
        passwordConfirm: $('#setupPasswordConfirm').value
      }
    });
    $('#setupPassword').value = '';
    $('#setupPasswordConfirm').value = '';
    location.reload();
  } catch (err) {
    msg($('#setupMsg'), err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.currentTarget.querySelector('button[type="submit"]');
  btn.disabled = true;
  msg($('#loginMsg'), 'Anmeldung läuft …');
  try {
    await api('/api/login', {
      method: 'POST',
      body: {
        username: $('#username').value,
        password: $('#password').value
      }
    });
    $('#password').value = '';
    // Danach absichtlich neu laden, damit die neue serverseitige Session
    // für alle API-Aufrufe sicher aktiv ist.
    location.reload();
  } catch (err) {
    msg($('#loginMsg'), err.message, 'error');
    $('#password').focus();
    $('#password').select();
  } finally {
    btn.disabled = false;
  }
});

$('#logoutBtn').addEventListener('click', async()=>{try{await api('/api/logout',{method:'POST',body:{}})}finally{location.reload()}});
$('#bexioBtn').addEventListener('click',()=>{location.href='/auth/bexio/start'});
$('#refreshBtn').addEventListener('click',async()=>{await loadStatus();await loadDrafts()});

async function loadStatus(){
  try{
    const b=await api('/api/bexio/status');
    if(!b.connected){
      $('#statusText').innerHTML='bexio ist <strong>nicht verbunden</strong>. Bitte zuerst oben „bexio verbinden“ wählen.';
      $('#bexioBtn').hidden=false; state.catalog=null; return;
    }
    $('#bexioBtn').textContent='bexio neu verbinden';
    const c=await api('/api/catalog'); state.catalog=c;
    const diagnostics = c.diagnostics || {};
    const articleGroupSamples = Array.isArray(diagnostics.articleGroupSamples) ? diagnostics.articleGroupSamples : [];
    const foundContactGroups = Array.isArray(diagnostics.foundContactGroups) ? diagnostics.foundContactGroups : [];
    const foundContactBranches = Array.isArray(diagnostics.foundContactBranches) ? diagnostics.foundContactBranches : [];
    const allContactGroups = Array.isArray(diagnostics.allContactGroups) ? diagnostics.allContactGroups : [];
    const allContactBranches = Array.isArray(diagnostics.allContactBranches) ? diagnostics.allContactBranches : [];
    const productDiag = diagnostics.productGroupSetupRequired
      ? ` · <strong>Produktgruppen noch nicht gefiltert</strong><br><small>Gruppen-IDs mit Beispielen: ${articleGroupSamples.map(g=>`${g.id}: ${(Array.isArray(g.samples)?g.samples:[]).map(esc).join(' / ')}`).join(' · ') || 'keine'}</small>`
      : ` · ${Array.isArray(c.articles) ? c.articles.length : 0} freigegebene Produkte`;
    const contactDiag = `<br><small>Kundengruppen gefunden: ${esc(foundContactGroups.join(', ')||'keine')} · Branchen gefunden: ${esc(foundContactBranches.join(', ')||'keine')}</small>`
      + `<br><small>Alle Kontaktgruppen: ${allContactGroups.map(x=>`${x.id}: ${esc(x.name)}`).join(' · ') || 'keine'}</small>`
      + `<br><small>Alle Branchen: ${allContactBranches.map(x=>`${x.id}: ${esc(x.name)}`).join(' · ') || 'keine'}</small>`;
    $('#statusText').innerHTML=`bexio verbunden · ${Array.isArray(c.contacts) ? c.contacts.length : 0} freigegebene Kunden${productDiag}${contactDiag}`;
    if(!$('#items').children.length) addItemRow();
  }catch(e){ $('#statusText').textContent=e.message; }
}


$('#productAdminBtn').addEventListener('click', async()=>{
  $('#productAdminCard').hidden=false;
  $('#productAdminCard').scrollIntoView({behavior:'smooth',block:'start'});
  await loadProductAdmin();
});
$('#closeProductAdminBtn').addEventListener('click',()=>{$('#productAdminCard').hidden=true});
$('#productAdminSearch').addEventListener('input',renderProductAdmin);
$('#enableVisibleBtn').addEventListener('click',()=>setVisibleProductChecks(true));
$('#disableVisibleBtn').addEventListener('click',()=>setVisibleProductChecks(false));
$('#saveProductAdminBtn').addEventListener('click',saveProductAdmin);

async function loadProductAdmin(){
  msg($('#productAdminMsg'),'Produkte werden aus bexio geladen …');
  try{
    const data=await api('/api/admin/products');
    state.adminProducts=Array.isArray(data.products)?data.products:[];
    renderProductAdmin();
    msg($('#productAdminMsg'),data.configured?'Gespeicherte Auswahl geladen.':'Noch keine individuelle Auswahl gespeichert – aktuell sind alle Kandidaten aktiv.');
  }catch(e){msg($('#productAdminMsg'),e.message,'error')}
}

function filteredAdminProducts(){
  const q=$('#productAdminSearch').value.trim().toLowerCase();
  if(!q) return state.adminProducts;
  return state.adminProducts.filter(p=>`${p.name||''} ${p.code||''} ${p.id||''}`.toLowerCase().includes(q));
}

function renderProductAdmin(){
  const rows=filteredAdminProducts();
  const list=$('#productAdminList');
  const enabled=state.adminProducts.filter(p=>p.enabled).length;
  $('#productAdminSummary').textContent=`${enabled} von ${state.adminProducts.length} Produkten aktiviert · ${rows.length} aktuell angezeigt`;
  if(!rows.length){list.innerHTML='<p class="muted">Keine Produkte gefunden.</p>';return}
  list.innerHTML=rows.map(p=>`<label class="product-admin-row" data-id="${p.id}">
    <input type="checkbox" class="productEnabled" data-id="${p.id}" ${p.enabled?'checked':''}>
    <span class="product-admin-main"><strong>${esc(p.name)}</strong>${p.code?` <span class="product-code">${esc(p.code)}</span>`:''}<small>${esc(money(p.sale_price))}${p.unit_name?` / ${esc(p.unit_name)}`:''} · Gruppe ${esc(p.group_id)}</small></span>
  </label>`).join('');
  list.querySelectorAll('.productEnabled').forEach(cb=>cb.addEventListener('change',()=>{
    const p=state.adminProducts.find(x=>Number(x.id)===Number(cb.dataset.id)); if(p) p.enabled=cb.checked;
    const count=state.adminProducts.filter(x=>x.enabled).length;
    $('#productAdminSummary').textContent=`${count} von ${state.adminProducts.length} Produkten aktiviert · ${rows.length} aktuell angezeigt`;
  }));
}

function setVisibleProductChecks(enabled){
  const ids=new Set(filteredAdminProducts().map(p=>Number(p.id)));
  state.adminProducts.forEach(p=>{if(ids.has(Number(p.id))) p.enabled=enabled});
  renderProductAdmin();
}

async function saveProductAdmin(){
  const btn=$('#saveProductAdminBtn'); btn.disabled=true; msg($('#productAdminMsg'),'Speichere …');
  try{
    const products=state.adminProducts.map((p,index)=>({article_id:Number(p.id),enabled:p.enabled===true,display_name:p.display_name||'',sort_order:Number(p.sort_order||0)||index}));
    const r=await api('/api/admin/products',{method:'POST',body:{products}});
    msg($('#productAdminMsg'),`${r.enabled} Produkte sind jetzt im Bestell-Dropdown sichtbar.`,'ok');
    await loadStatus();
    $('#items').innerHTML=''; addItemRow();
  }catch(e){msg($('#productAdminMsg'),e.message,'error')}finally{btn.disabled=false}
}

$('#contactSearch').addEventListener('input',()=>{
  const q=$('#contactSearch').value.trim().toLowerCase();
  const box=$('#contactResults');
  if(!state.catalog||q.length<1){box.innerHTML='';return}
  const rows=state.catalog.contacts.filter(c=>`${c.name} ${c.city} ${c.nr}`.toLowerCase().includes(q)).slice(0,30);
  box.innerHTML=rows.map(c=>`<div class="result" data-id="${c.id}"><strong>${esc(c.name)}</strong>${c.city?` · ${esc(c.city)}`:''}</div>`).join('');
  box.querySelectorAll('.result').forEach(el=>el.addEventListener('click',()=>selectContact(Number(el.dataset.id))));
});

function selectContact(id){
  const c=state.catalog.contacts.find(x=>Number(x.id)===Number(id)); if(!c)return;
  state.selectedContact=c; $('#selectedContact').hidden=false; $('#selectedContact').textContent=`${c.name}${c.city?` · ${c.city}`:''}`; $('#contactResults').innerHTML=''; $('#contactSearch').value='';
}

$('#addItemBtn').addEventListener('click',addItemRow);
function addItemRow(){
  if(!state.catalog) return;
  const div=document.createElement('div'); div.className='item-row';
  const options=state.catalog.articles.map(a=>`<option value="${a.id}">${esc(a.name)}${a.code?` (${esc(a.code)})`:''} · ${esc(money(a.sale_price))}${a.unit_name?` / ${esc(a.unit_name)}`:''}</option>`).join('');
  div.innerHTML=`<div class="article-wrap">
    <select class="article"><option value="">Produkt auswählen …</option>${options}</select>
    <div class="price-hint muted">Preis wird aus bexio geladen.</div>
  </div>
  <input class="quantity" type="number" min="0.001" step="0.001" placeholder="Menge">
  <button class="remove-item" type="button" title="Entfernen">×</button>`;
  const select=div.querySelector('.article');
  const hint=div.querySelector('.price-hint');
  select.addEventListener('change',()=>{
    const a=state.catalog.articles.find(x=>Number(x.id)===Number(select.value));
    hint.textContent=a?`${money(a.sale_price)}${a.unit_name?` pro ${a.unit_name}`:''}`:'Preis wird aus bexio geladen.';
  });
  div.querySelector('.remove-item').addEventListener('click',()=>div.remove());
  $('#items').appendChild(div);
}

$('#saveDraftBtn').addEventListener('click',async()=>{
  const btn=$('#saveDraftBtn');
  if(btn.disabled) return;
  msg($('#draftMsg'),'');
  btn.disabled=true;
  try{
    if(!state.selectedContact) throw new Error('Bitte einen Kunden auswählen.');
    const items=[...document.querySelectorAll('.item-row')].map(r=>({article_id:Number(r.querySelector('.article').value),quantity:Number(r.querySelector('.quantity').value)})).filter(x=>x.article_id&&x.quantity>0);
    if(!items.length) throw new Error('Bitte mindestens ein Produkt und eine Menge eingeben.');
    msg($('#draftMsg'),'Bestellung wird gespeichert …');
    const r=await api('/api/drafts',{method:'POST',body:{contact_id:state.selectedContact.id,contact_name:state.selectedContact.name,delivery_date:$('#deliveryDate').value,items,client_key:state.draftKey}});
    msg($('#draftMsg'),r?.duplicate?'Diese Bestellung war bereits gespeichert (kein Duplikat angelegt).':'Bestellung zur Warteliste hinzugefügt.','ok');
    state.draftKey=newDraftKey();
    state.selectedContact=null; $('#selectedContact').hidden=true; $('#items').innerHTML=''; addItemRow(); await loadDrafts();
  }catch(e){msg($('#draftMsg'),e.message,'error')}
  finally{btn.disabled=false}
});

async function loadDrafts(){
  try{state.drafts=await api('/api/drafts');renderDrafts()}catch(e){$('#drafts').innerHTML=`<div class="msg error">${esc(e.message)}</div>`}
}

function renderDrafts(){
  const box=$('#drafts');
  if(!state.drafts.length){box.innerHTML='<p class="muted">Noch keine Bestellungen.</p>';return}
  box.innerHTML=state.drafts.map(d=>`<div class="draft">
    <div class="selectline"><input type="checkbox" class="draftCheck" data-id="${d.id}" ${['draft','failed','created'].includes(d.status)?'':'disabled'}>
      <div style="flex:1"><div class="draft-top"><div><div class="draft-title">${esc(d.contact_name)}</div><div class="draft-meta">${esc(displayDate(d.delivery_date))} ${d.bexio_delivery_nr?`· ${esc(d.bexio_delivery_nr)}`:''}</div></div><span class="status ${esc(d.status)}">${statusLabel(d.status)}</span></div>
      <ul class="draft-items">${d.items.map(i=>`<li>${esc(i.article_name)} · ${qty(i.quantity)}</li>`).join('')}</ul>
      ${d.error_message?`<div class="draft-error">${esc(d.error_message)}</div>`:''}
      <div class="draft-actions">
        ${['draft','failed'].includes(d.status)?`<button type="button" class="small createOneBtn" data-id="${d.id}">Lieferschein erstellen</button><button type="button" class="danger small deleteDraftBtn" data-id="${d.id}">Bestellung löschen</button>`:''}
        ${d.status==='created'?`<button type="button" class="secondary small printOneBtn" data-id="${d.id}">Lieferschein drucken</button><button type="button" class="danger small deleteDraftBtn" data-id="${d.id}">Aus Portal entfernen</button>`:''}
      </div>
      </div>
    </div>
  </div>`).join('');
}
function statusLabel(s){return ({draft:'offen',processing:'in Bearbeitung',created:'Lieferschein erstellt',failed:'Fehler',cancelled:'storniert'})[s]||s}
function checked(){return [...document.querySelectorAll('.draftCheck:checked')].map(x=>x.dataset.id)}


async function processIds(ids){
  if(!ids.length)return;
  const r=await api('/api/drafts/process-all',{method:'POST',body:{ids}});
  const failed=r.results.filter(x=>!x.ok);
  alert(failed.length?`${r.results.length-failed.length} erstellt, ${failed.length} mit Fehler.`:`${r.results.length} Lieferschein(e) erstellt.`);
  await loadDrafts();
}

$('#drafts').addEventListener('click',async(e)=>{
  const createBtn=e.target.closest('.createOneBtn');
  if(createBtn){
    const id=createBtn.dataset.id;
    if(!confirm('Diesen Lieferschein jetzt erstellen?'))return;
    createBtn.disabled=true;
    try{await processIds([id])}catch(err){alert(err.message)}finally{createBtn.disabled=false}
    return;
  }
  const deleteBtn=e.target.closest('.deleteDraftBtn');
  if(deleteBtn){
    const id=deleteBtn.dataset.id;
    const d=state.drafts.find(x=>x.id===id);
    const name=d?.contact_name ? ` für ${d.contact_name}` : '';
    const alreadyCreated=d?.status==='created';
    const warning=alreadyCreated
      ? `Bestellung${name} aus dem Portal entfernen?\n\nWICHTIG: Der bereits erstellte Lieferschein ${d?.bexio_delivery_nr||''} bleibt in bexio unverändert bestehen. Es wird nur der Eintrag aus dieser Portal-Liste entfernt.`
      : `Bestellung${name} wirklich löschen?\n\nDie Bestellung wird aus der Warteliste entfernt.`;
    if(!confirm(warning))return;
    deleteBtn.disabled=true;
    try{
      await api(`/api/drafts/${encodeURIComponent(id)}`,{method:'DELETE'});
      await loadDrafts();
    }catch(err){alert(err.message)}finally{deleteBtn.disabled=false}
    return;
  }
  const printBtn=e.target.closest('.printOneBtn');
  if(printBtn){
    window.open(`/print?ids=${encodeURIComponent(printBtn.dataset.id)}`,'_blank','noopener');
  }
});

$('#processAllOpenBtn').addEventListener('click',async()=>{
  const ids=state.drafts.filter(d=>['draft','failed'].includes(d.status)).map(d=>d.id);
  if(!ids.length)return alert('Keine offenen Bestellungen vorhanden.');
  if(!confirm(`${ids.length} offene Lieferschein(e) erstellen?`))return;
  $('#processAllOpenBtn').disabled=true;
  try{await processIds(ids)}catch(e){alert(e.message)}finally{$('#processAllOpenBtn').disabled=false}
});

$('#printAllCreatedBtn').addEventListener('click',()=>{
  const ids=state.drafts.filter(d=>d.status==='created').map(d=>d.id);
  if(!ids.length)return alert('Noch keine erstellten Lieferscheine vorhanden.');
  window.open(`/print?ids=${encodeURIComponent(ids.join(','))}`,'_blank','noopener');
});

$('#archiveAllVisibleBtn').addEventListener('click',async()=>{
  const ids=state.drafts.map(d=>d.id);
  if(!ids.length)return alert('Keine sichtbaren Bestellungen vorhanden.');
  const created=state.drafts.filter(d=>d.status==='created').length;
  const extra=created?`

${created} bereits erstellte Lieferschein(e) bleiben in bexio unverändert bestehen.`:'';
  if(!confirm(`Alle ${ids.length} aktuell sichtbaren Bestellungen aus dem Portal archivieren?${extra}`))return;
  const btn=$('#archiveAllVisibleBtn'); btn.disabled=true;
  try{
    const r=await api('/api/drafts/archive-all',{method:'POST',body:{ids}});
    alert(`${r.archived} Bestellung(en) archiviert.`);
    await loadDrafts();
  }catch(e){alert(e.message)}finally{btn.disabled=false}
});

$('#processSelectedBtn').addEventListener('click',async()=>{
  const ids=checked().filter(id=>{const d=state.drafts.find(x=>x.id===id);return d&&['draft','failed'].includes(d.status)});
  if(!ids.length)return alert('Bitte offene oder fehlgeschlagene Bestellungen auswählen.');
  if(!confirm(`${ids.length} Lieferschein(e) erstellen?`))return;
  $('#processSelectedBtn').disabled=true;
  try{
    const r=await api('/api/drafts/process-all',{method:'POST',body:{ids}});
    const failed=r.results.filter(x=>!x.ok);
    alert(failed.length?`${r.results.length-failed.length} erstellt, ${failed.length} mit Fehler.`:`${r.results.length} Lieferschein(e) erstellt.`);
    await loadDrafts();
  }catch(e){alert(e.message)}finally{$('#processSelectedBtn').disabled=false}
});

$('#printSelectedBtn').addEventListener('click',()=>{
  const ids=checked().filter(id=>{const d=state.drafts.find(x=>x.id===id);return d?.status==='created'});
  if(!ids.length)return alert('Bitte bereits erstellte Lieferscheine auswählen.');
  window.open(`/print?ids=${encodeURIComponent(ids.join(','))}`,'_blank','noopener');
});

boot().catch(e=>{console.error(e);showLogin()});


// ---------- Monatsauswertung / manuelle Umsätze ----------
function todayIso(){ return localIsoDate(); }
function monthIso(){ return localIsoDate().slice(0,7); }
function chf(v){ return new Intl.NumberFormat('de-CH',{style:'currency',currency:'CHF'}).format(Number(v||0)); }

function openReporting(){
  $('#reportingCard').hidden=false;
  $('#reportingCard').scrollIntoView({behavior:'smooth',block:'start'});
  if(!$('#reportMonth').value) $('#reportMonth').value=monthIso();
  if(!$('#manualSaleDate').value) $('#manualSaleDate').value=todayIso();
  populateManualSaleProducts();
  updateManualSaleFields();
  $('#employeeAdmin').hidden = state.user?.role !== 'admin';
  loadEmployees();
  loadReporting();
}

// ---------- Mitarbeitende ----------
function empName(e){ return [e.first_name,e.last_name].filter(Boolean).join(' '); }
async function loadEmployees(){
  try{
    state.employees=await api('/api/employees');
    populateEmployeeSelect();
    renderEmployees();
  }catch(e){ msg($('#employeeMsg'),e.message,'error'); }
}
function populateEmployeeSelect(){
  const sel=$('#manualSalePerson'); const current=sel.value;
  const active=(state.employees||[]).filter(e=>e.active);
  sel.innerHTML=active.length
    ? active.map(e=>`<option value="${e.id}">${esc(empName(e))}</option>`).join('')
    : '<option value="">Keine aktiven Personen – unten erfassen</option>';
  if([...sel.options].some(o=>o.value===current)) sel.value=current;
}
function renderEmployees(){
  const list=$('#employeeList'); if(!list) return;
  const rows=state.employees||[];
  list.innerHTML=rows.map(e=>{
    const addr=[e.street,[e.zip,e.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const missing=!e.last_name||!e.street||!e.zip||!e.city;
    return `<div class="employee-row ${e.active?'':'inactive'}"><div><strong>${esc(empName(e))}</strong>${e.active?'':' · inaktiv'}
      <small>${addr?esc(addr):'Keine Adresse'}${e.ahv_number?` · AHV ${esc(e.ahv_number)}`:''}${missing?' · <span style="color:#a72c2c">Angaben für Lohnabrechnung unvollständig</span>':''}</small></div>
      <button type="button" class="secondary small editEmployeeBtn" data-id="${e.id}">Bearbeiten</button></div>`;
  }).join('') || '<p class="muted">Noch keine Personen erfasst.</p>';
}
function resetEmployeeForm(){
  $('#employeeForm').reset(); $('#employeeId').value=''; $('#empActive').checked=true;
  $('#empSaveBtn').textContent='Person hinzufügen'; $('#empCancelBtn').hidden=true;
}
$('#employeeList').addEventListener('click',(ev)=>{
  const btn=ev.target.closest('.editEmployeeBtn'); if(!btn) return;
  const e=(state.employees||[]).find(x=>String(x.id)===btn.dataset.id); if(!e) return;
  $('#employeeId').value=e.id; $('#empFirst').value=e.first_name||''; $('#empLast').value=e.last_name||'';
  $('#empStreet').value=e.street||''; $('#empZip').value=e.zip||''; $('#empCity').value=e.city||'';
  $('#empAhv').value=e.ahv_number||''; $('#empActive').checked=!!e.active;
  $('#empSaveBtn').textContent='Änderungen speichern'; $('#empCancelBtn').hidden=false;
  msg($('#employeeMsg'),''); $('#empFirst').focus();
});
$('#empCancelBtn').addEventListener('click',()=>{resetEmployeeForm();msg($('#employeeMsg'),'')});
$('#employeeForm').addEventListener('submit',async(ev)=>{
  ev.preventDefault();
  const btn=$('#empSaveBtn'); btn.disabled=true;
  const id=$('#employeeId').value;
  const body={first_name:$('#empFirst').value,last_name:$('#empLast').value,street:$('#empStreet').value,zip:$('#empZip').value,city:$('#empCity').value,ahv_number:$('#empAhv').value,active:$('#empActive').checked};
  try{
    await api(id?`/api/employees/${encodeURIComponent(id)}`:'/api/employees',{method:id?'PUT':'POST',body});
    msg($('#employeeMsg'),id?'Änderungen gespeichert.':'Person hinzugefügt.','ok');
    resetEmployeeForm(); await loadEmployees(); await loadReporting();
  }catch(e){ msg($('#employeeMsg'),e.message,'error'); }
  finally{ btn.disabled=false; }
});
function populateManualSaleProducts(){
  const sel=$('#manualSaleArticle');
  if(!sel || !state.catalog) return;
  const current=sel.value;
  sel.innerHTML='<option value="">– kein Produkt –</option>'+state.catalog.articles.map(a=>`<option value="${a.id}">${esc(a.name)}${a.unit_name?` (${esc(a.unit_name)})`:''}</option>`).join('');
  if([...sel.options].some(o=>o.value===current)) sel.value=current;
}

function updateManualSaleFields(){
  const isBern=$('#manualSaleCategory').value==='Märit Bern';
  $('#manualStandardFields').hidden=isBern;
  $('#manualBernFields').hidden=!isBern;
  updateBernTotal();
}
function updateBernTotal(){
  const cash=Number($('#manualSaleCash')?.value||0);
  const twint=Number($('#manualSaleTwint')?.value||0);
  if($('#manualBernTotal')) $('#manualBernTotal').textContent=chf(cash+twint);
}
$('#manualSaleCategory').addEventListener('change',updateManualSaleFields);
$('#manualSaleCash').addEventListener('input',updateBernTotal);
$('#manualSaleTwint').addEventListener('input',updateBernTotal);

async function loadReporting(){
  const month=$('#reportMonth').value || monthIso();
  msg($('#reportWarning'),'');
  try{
    const r=await api(`/api/reporting/monthly?month=${encodeURIComponent(month)}`);
    const s=r.summary||{};
    $('#reportSummary').innerHTML=`
      <div class="summary-card"><span>Gesamtumsatz</span><strong>${chf(s.total_revenue)}</strong></div>
      <div class="summary-card"><span>Lieferportal</span><strong>${chf(s.bexio_revenue)}</strong></div>
      <div class="summary-card"><span>Manuell</span><strong>${chf(s.manual_revenue)}</strong></div>
      <div class="summary-card"><span>Verkauft kg</span><strong>${qty(s.kg_total)} kg</strong></div>
      <div class="summary-card"><span>Kunden</span><strong>${Number(s.customers||0)}</strong></div>`;
    if(Number(s.estimated_legacy_items||0)>0){
      msg($('#reportWarning'),`${s.estimated_legacy_items} ältere Position(en) haben noch keinen gespeicherten Verkaufspreis. Für diese wird der aktuelle bexio-Preis als Schätzung verwendet.`);
    }
    $('#productReportRows').innerHTML=(r.products||[]).map(p=>`<tr>
      <td><strong>${esc(p.name)}</strong>${Number(p.manual_quantity||0)>0?`<small>inkl. ${qty(p.manual_quantity)} manuell</small>`:''}</td>
      <td>${qty(p.quantity)} ${esc(p.unit||'')}</td>
      <td>${chf(p.revenue)}</td>
      <td>${Number(p.customers||0)}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="muted">Keine Verkäufe in diesem Monat.</td></tr>';

    $('#customerReportRows').innerHTML=(r.customers||[]).map(c=>`<tr>
      <td><strong>${esc(c.name)}</strong><details><summary>Produkte anzeigen</summary>${(c.products||[]).map(p=>`<div class="detail-line">${esc(p.name)}: ${qty(p.quantity)} ${esc(p.unit||'')} · ${chf(p.revenue)}</div>`).join('')}</details></td>
      <td>${qty(c.kg)} kg</td>
      <td>${chf(c.revenue)}</td>
      <td>${Number(c.deliveries||0)}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="muted">Keine Lieferungen in diesem Monat.</td></tr>';

    $('#marketPayrollCards').innerHTML=(r.market_payroll||[]).map(p=>`
      <div class="payroll-card">
        <h4>${esc(p.salesperson)}</h4>
        <div><span>Arbeitstage</span><strong>${Number(p.days||0)}</strong></div>
        <div><span>Märit-Umsatz</span><strong>${chf(p.revenue)}</strong></div>
        <div><span>Bruttolohn</span><strong>${chf(p.gross_wage)}</strong></div>
        <div><span>AHV/IV/EO 5.30%</span><strong>− ${chf(p.ahv_iv_eo)}</strong></div>
        <div><span>ALV 1.10%</span><strong>− ${chf(p.alv)}</strong></div>
        <div class="net"><span>Nettolohn</span><strong>${chf(p.net_wage)}</strong></div>
        <button type="button" class="secondary small payrollSlipBtn" data-employee="${esc(p.employee_id||'')}" data-month="${esc(r.month||month)}">Lohnabrechnung erstellen</button>
      </div>`).join('') || '<div class="muted">Noch keine Märit-Bern-Lohnbuchungen in diesem Monat.</div>';

    $('#marketPayrollDailyRows').innerHTML=(r.market_payroll||[]).flatMap(p=>
      (p.daily||[]).map(d=>`<tr>
        <td><strong>${esc(p.salesperson)}</strong></td>
        <td>${esc(displayDate(d.sale_date))}</td>
        <td>${chf(d.cash)}</td>
        <td>${chf(d.twint)}</td>
        <td><strong>${chf(d.revenue)}</strong></td>
        <td><strong>${chf(d.gross_wage)}</strong></td>
      </tr>`)
    ).join('') || '<tr><td colspan="6" class="muted">Keine Märit-Bern-Tage in diesem Monat.</td></tr>';

    $('#manualSaleRows').innerHTML=(r.manual_sales||[]).map(m=>`<tr>
      <td>${esc(displayDate(m.sale_date))}</td>
      <td>${esc(m.category)}</td>
      <td>${esc(m.salesperson||'–')}</td>
      <td>${m.category==='Märit Bern'?chf(m.cash_chf):'–'}</td>
      <td>${m.category==='Märit Bern'?chf(m.twint_chf):'–'}</td>
      <td><strong>${chf(m.amount_chf)}</strong></td>
      <td>${m.article_name?`${esc(m.article_name)}${m.quantity?` · ${qty(m.quantity)} ${esc(m.unit_name||'')}`:''}`:'–'}</td>
      <td>${esc(m.note||'')}</td>
      <td><button class="danger small deleteManualSaleBtn" data-id="${m.id}" type="button">Löschen</button></td>
    </tr>`).join('') || '<tr><td colspan="9" class="muted">Keine manuellen Buchungen in diesem Monat.</td></tr>';
  }catch(e){ msg($('#reportWarning'),e.message,'error'); }
}

$('#marketPayrollCards').addEventListener('click',(e)=>{
  const btn=e.target.closest('.payrollSlipBtn'); if(!btn)return;
  if(!btn.dataset.employee) return alert('Diese Buchungen sind keiner erfassten Person zugeordnet.');
  const q=new URLSearchParams({month:btn.dataset.month,employee:btn.dataset.employee});
  window.open(`/payroll-slip?${q}`,'_blank','noopener');
});

$('#reportingBtn').addEventListener('click',openReporting);
$('#closeReportingBtn').addEventListener('click',()=>{$('#reportingCard').hidden=true});
$('#loadReportBtn').addEventListener('click',loadReporting);
$('#reportMonth').addEventListener('change',loadReporting);

$('#manualSaleArticle').addEventListener('change',()=>{
  if(!$('#manualSaleArticle').value) $('#manualSaleQuantity').value='';
});

$('#saveManualSaleBtn').addEventListener('click',async()=>{
  const btn=$('#saveManualSaleBtn'); btn.disabled=true; msg($('#manualSaleMsg'),'');
  try{
    const isBern=$('#manualSaleCategory').value==='Märit Bern';
    await api('/api/manual-sales',{method:'POST',body:{
      sale_date:$('#manualSaleDate').value,
      category:$('#manualSaleCategory').value,
      amount_chf:isBern ? null : Number($('#manualSaleAmount').value),
      employee_id:isBern ? Number($('#manualSalePerson').value)||null : null,
      cash_chf:isBern ? Number($('#manualSaleCash').value||0) : null,
      twint_chf:isBern ? Number($('#manualSaleTwint').value||0) : null,
      article_id:(!isBern && $('#manualSaleArticle').value)?Number($('#manualSaleArticle').value):null,
      quantity:!isBern ? $('#manualSaleQuantity').value : null,
      note:$('#manualSaleNote').value
    }});
    $('#manualSaleAmount').value='';
    $('#manualSaleArticle').value='';
    $('#manualSaleQuantity').value='';
    $('#manualSaleCash').value='';
    $('#manualSaleTwint').value='';
    $('#manualSaleNote').value='';
    updateBernTotal();
    msg($('#manualSaleMsg'),'Manuelle Buchung gespeichert.','ok');
    await loadReporting();
  }catch(e){ msg($('#manualSaleMsg'),e.message,'error'); }
  finally{btn.disabled=false}
});

$('#manualSaleRows').addEventListener('click',async(e)=>{
  const btn=e.target.closest('.deleteManualSaleBtn'); if(!btn)return;
  if(!confirm('Diese manuelle Buchung wirklich löschen?')) return;
  try{
    await api(`/api/manual-sales/${btn.dataset.id}`,{method:'DELETE'});
    await loadReporting();
  }catch(err){alert(err.message)}
});
