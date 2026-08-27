const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const state = { me:null, relationships:[], conversations:[], active:null, messages:[], messageUsers:{}, friendFilter:'friends', socket:null, typingTimer:null, searchTimer:null, pendingAttachment:null, bound:false };

async function api(url, opts={}) {
  const r = await fetch(url, { headers:{'content-type':'application/json',...(opts.headers||{})}, ...opts });
  const d = await r.json().catch(()=>({}));
  if(!r.ok){const e=new Error(d.error||'REQUEST_FAILED');e.data=d;throw e} return d;
}
function esc(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function initials(u){return (u?.display_name||u?.username||'?').split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase()}
function avatarHtml(u,cls='avatar'){return `<span class="${cls}" ${u?.avatar_url?`style="background-image:url('${esc(u.avatar_url)}')"`:''}>${u?.avatar_url?'':esc(initials(u))}</span>`}
function applyAvatar(el,u){el.style.backgroundImage=u?.avatar_url?`url("${u.avatar_url.replaceAll('"','')}")`:'';el.textContent=u?.avatar_url?'':initials(u)}
function toast(title,text=''){const el=document.createElement('div');el.className='toast';el.innerHTML=`<b>${esc(title)}</b>${text?`<span>${esc(text)}</span>`:''}`;$('#toastRoot').append(el);setTimeout(()=>el.remove(),3500)}
function showOnly(id){['#gateView','#authView','#appView'].forEach(s=>$(s).classList.add('hidden'));$(id).classList.remove('hidden')}
function linkify(text=''){return esc(text).replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')}
function fmtTime(v){try{return new Intl.DateTimeFormat([], {hour:'numeric',minute:'2-digit'}).format(new Date(v))}catch{return ''}}
function fmtDateTime(v){try{return new Intl.DateTimeFormat([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(v))}catch{return ''}}
function fmtRelative(v){if(!v)return 'OFFLINE';const s=Math.floor((Date.now()-new Date(v))/1000);if(s<60)return 'JUST NOW';if(s<3600)return `${Math.floor(s/60)}M AGO`;if(s<86400)return `${Math.floor(s/3600)}H AGO`;return `${Math.floor(s/86400)}D AGO`}
function presenceText(u){if(u?.status==='online')return u.custom_status?`ONLINE  /  ${u.custom_status}`:'ONLINE';return `OFFLINE  /  ${fmtRelative(u?.last_seen)}`}
function messagePreview(last){if(!last)return 'NO MESSAGES';if(last.attachment_type==='image'&&!last.content)return 'IMAGE';return (last.content||'IMAGE').slice(0,38)}

async function boot(){
  try{const d=await api('/api/bootstrap');if(!d.gate){showOnly('#gateView');return}if(!d.user){showOnly('#authView');return}state.me=d.user;showOnly('#appView');await initApp()}catch{showOnly('#gateView')}
}
$('#gateForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/gate',{method:'POST',body:JSON.stringify({passcode:$('#gatePasscode').value})});showOnly('#authView')}catch{toast('ACCESS DENIED','Invalid or expired license key.')}});
$$('[data-auth-tab]').forEach(btn=>btn.onclick=()=>{$$('[data-auth-tab]').forEach(x=>x.classList.toggle('active',x===btn));$('#loginForm').classList.toggle('hidden',btn.dataset.authTab!=='login');$('#registerForm').classList.toggle('hidden',btn.dataset.authTab!=='register')});
$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();try{const d=await api('/api/auth/login',{method:'POST',body:JSON.stringify({username:$('#loginUsername').value,password:$('#loginPassword').value})});state.me=d.user;showOnly('#appView');await initApp()}catch(err){toast('LOGIN FAILED',err.message==='ACCOUNT_BANNED'?(err.data?.reason||'This account is banned.'):'Check username and password.')}});
$('#registerForm').addEventListener('submit',async e=>{e.preventDefault();try{const d=await api('/api/auth/register',{method:'POST',body:JSON.stringify({displayName:$('#registerDisplay').value,username:$('#registerUsername').value,password:$('#registerPassword').value})});state.me=d.user;showOnly('#appView');await initApp()}catch(err){const m={USERNAME_TAKEN:'That username is taken.',USERNAME_RULES:'Use 3–24 letters, numbers, or underscores.',PASSWORD_RULES:'Password must be at least 8 characters.'}[err.message]||'Could not create account.';toast('ACCOUNT NOT CREATED',m)}});

async function initApp(){if(!state.bound){bindApp();state.bound=true}renderMe();connectSocket();await refreshCore()}
function bindApp(){
  $$('[data-main-tab]').forEach(b=>b.onclick=()=>switchMainTab(b.dataset.mainTab));
  $$('[data-friend-filter]').forEach(b=>b.onclick=()=>{state.friendFilter=b.dataset.friendFilter;$$('[data-friend-filter]').forEach(x=>x.classList.toggle('active',x===b));renderFriends()});
  $('#friendSearchForm').addEventListener('submit',e=>{e.preventDefault();searchPeople($('#friendSearch').value)});
  $('#friendSearch').addEventListener('input',()=>{clearTimeout(state.searchTimer);const q=$('#friendSearch').value.trim();if(q.length<2){$('#friendSearchResults').classList.add('hidden');$('#friendSearchResults').innerHTML='';return}state.searchTimer=setTimeout(()=>searchPeople(q),220)});
  $('#composer').addEventListener('submit',sendMessage);
  $('#messageInput').addEventListener('input',composerInput);
  $('#messageInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('#composer').requestSubmit()}});
  $('#messageInput').addEventListener('paste',handlePasteImage);
  $('#attachBtn').onclick=()=>$('#imageInput').click();
  $('#imageInput').onchange=()=>{const f=$('#imageInput').files?.[0];if(f)prepareAttachment(f)};
  $('#pingBtn').onclick=pingActive;
  $('#settingsBtn').onclick=openSettings;
  $('#adminBtn').onclick=openAdminPanel;
  $('#newGroupBtn').onclick=openNewGroup;
  $('#brandBtn').onclick=()=>switchMainTab('chats');
  $$('[data-mobile-back]').forEach(b=>b.onclick=()=>$('#chatPanel').classList.add('hidden'));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(!$('#modalRoot').classList.contains('hidden'))closeModal();else closeAdminPanel()}});
}
function renderMe(){applyAvatar($('#settingsBtn'),state.me);applyAvatar($('#meAvatar'),state.me);$('#meDisplay').textContent=state.me.display_name;$('#meUsername').textContent='@'+state.me.username;const privileged=['admin','mod'].includes(state.me.role);$('#adminBtn').classList.toggle('hidden',!privileged);$('#adminBtn').textContent=state.me.role==='admin'?'ADMIN':'MOD';if(!privileged)closeAdminPanel()}
async function refreshCore(){await Promise.all([refreshFriends(),refreshConversations()]);renderRequestBadge();renderFriends();renderConversations()}
async function refreshFriends(){const d=await api('/api/friends');state.relationships=d.relationships||[]}
async function refreshConversations(){const d=await api('/api/conversations');state.conversations=d.conversations||[];renderConversations()}
function buckets(){const me=state.me.id;return {accepted:state.relationships.filter(r=>r.status==='accepted'),incoming:state.relationships.filter(r=>r.status==='pending'&&r.receiver_id===me),sent:state.relationships.filter(r=>r.status==='pending'&&r.sender_id===me)}}
function renderRequestBadge(){const n=buckets().incoming.length;$('#requestBadge').textContent=n;$('#requestBadge').classList.toggle('hidden',!n)}
function switchMainTab(tab){$$('[data-main-tab]').forEach(b=>b.classList.toggle('active',b.dataset.mainTab===tab));$('#chatsSide').classList.toggle('hidden',tab!=='chats');$('#friendsSide').classList.toggle('hidden',tab!=='friends');$('#newGroupBtn').classList.toggle('hidden',tab!=='chats')}
function renderConversations(){
  const el=$('#conversationList');
  if(!state.conversations.length){el.innerHTML='<div class="empty">NO CHATS YET</div>';return}
  el.innerHTML=state.conversations.map(c=>{
    if(c.type==='group')return `<button class="conversation ${state.active?.type==='group'&&state.active.id===c.id?'active':''}" data-conv-type="group" data-conv="${c.id}"><span class="group-avatar">#</span><span class="conv-copy"><b>${esc(c.group.name)}</b><small>${esc(messagePreview(c.last))}</small></span></button>`;
    return `<button class="conversation ${state.active?.type==='dm'&&state.active.id===c.id?'active':''}" data-conv-type="dm" data-conv="${c.id}">${avatarHtml(c.user)}<span class="conv-copy"><b>${esc(c.user.display_name)}</b><small>${esc(messagePreview(c.last))}</small></span></button>`;
  }).join('');
  $$('#conversationList [data-conv]').forEach(b=>b.onclick=()=>openConversation(b.dataset.convType,b.dataset.conv));
}
function renderFriends(){
  const {accepted,incoming,sent}=buckets();const el=$('#friendsList');
  if(state.friendFilter==='requests'){
    const rows=[...incoming.map(r=>({...r,kind:'incoming'})),...sent.map(r=>({...r,kind:'sent'}))];
    el.innerHTML=rows.length?rows.map(r=>`<div class="friend-row">${avatarHtml(r.user)}<span class="friend-copy"><b>${esc(r.user.display_name)}</b><small>@${esc(r.user.username)}${r.kind==='sent'?' / SENT':''}</small></span><span class="row-actions">${r.kind==='incoming'?`<button class="accept" data-accept="${r.id}">ACCEPT</button>`:''}<button data-remove="${r.id}">${r.kind==='sent'?'CANCEL':'DECLINE'}</button></span></div>`).join(''):'<div class="empty">NO REQUESTS</div>';
  } else {
    el.innerHTML=accepted.length?accepted.map(r=>`<div class="friend-row">${avatarHtml(r.user)}<span class="friend-copy"><b>${esc(r.user.display_name)}</b><small><i class="presence ${r.user.status==='online'?'online':''}"></i>${esc(presenceText(r.user))}</small></span><span class="row-actions"><button data-chat="${r.user.id}">CHAT</button><button data-remove="${r.id}">REMOVE</button></span></div>`).join(''):'<div class="empty">ADD A FRIEND TO START</div>';
  }
  wireFriendActions();
}
function wireFriendActions(){$$('#friendsList [data-chat]').forEach(b=>b.onclick=()=>openConversation('dm',b.dataset.chat));$$('#friendsList [data-accept]').forEach(b=>b.onclick=()=>acceptFriend(b.dataset.accept));$$('#friendsList [data-remove]').forEach(b=>b.onclick=()=>removeFriend(b.dataset.remove))}
async function searchPeople(q){if(q.trim().length<2)return;try{const d=await api('/api/users/search?q='+encodeURIComponent(q));const el=$('#friendSearchResults');el.classList.remove('hidden');el.innerHTML=d.users.length?d.users.map(u=>`<div class="search-row">${avatarHtml(u)}<span class="friend-copy"><b>${esc(u.display_name)}</b><small>@${esc(u.username)}</small></span><span class="row-actions"><button data-add="${u.id}">ADD</button></span></div>`).join(''):'<div class="empty">NO USERS FOUND</div>';$$('#friendSearchResults [data-add]').forEach(b=>b.onclick=()=>addFriend(b.dataset.add))}catch{toast('SEARCH FAILED')}}
async function addFriend(id){try{await api(`/api/friends/request/${id}`,{method:'POST'});toast('REQUEST SENT');$('#friendSearch').value='';$('#friendSearchResults').classList.add('hidden');await refreshFriends();renderFriends();renderRequestBadge()}catch(e){toast('REQUEST FAILED',e.message==='RELATION_EXISTS'?'Already connected or pending.':'Could not send request.')}}
async function acceptFriend(id){try{await api(`/api/friends/${id}/accept`,{method:'POST'});await refreshCore();toast('FRIEND ADDED')}catch{toast('FAILED')}}
async function removeFriend(id){try{await api(`/api/friends/${id}`,{method:'DELETE'});await refreshCore()}catch{toast('FAILED')}}

async function openConversation(type,id){
  if(type==='dm'){
    const rel=buckets().accepted.find(r=>r.user?.id===id);if(!rel)return;state.active={type:'dm',id,user:rel.user};
    applyAvatar($('#chatAvatar'),rel.user);$('#chatAvatar').classList.remove('group-avatar');$('#chatName').textContent=rel.user.display_name;$('#chatPresence').textContent=presenceText(rel.user);$('#pingBtn').classList.remove('hidden');
  }else{
    const d=await api(`/api/groups/${id}`);state.active={type:'group',id,group:d.group,members:d.members};
    $('#chatAvatar').style.backgroundImage='';$('#chatAvatar').textContent='#';$('#chatAvatar').classList.add('group-avatar');$('#chatName').textContent=d.group.name;$('#chatPresence').textContent=`${d.members.length} MEMBERS`;$('#pingBtn').classList.add('hidden');
  }
  state.pendingAttachment=null;renderAttachmentDraft();renderConversations();$('#emptyPanel').classList.add('hidden');$('#chatPanel').classList.remove('hidden');await loadMessages();setTimeout(()=>$('#messageInput').focus(),50);
}
async function loadMessages(){if(!state.active)return;const url=state.active.type==='dm'?`/api/messages/${state.active.id}`:`/api/groups/${state.active.id}/messages`;const d=await api(url);state.messages=d.messages||[];state.messageUsers=Object.fromEntries((d.users||[]).map(u=>[u.id,u]));state.messageUsers[state.me.id]=state.me;if(state.active.type==='dm')state.messageUsers[state.active.user.id]=state.active.user;else for(const u of state.active.members||[])state.messageUsers[u.id]=u;renderMessages();if(state.active.type==='dm'){for(const m of state.messages.slice(-20))if(m.receiver_id===state.me.id)api(`/api/messages/${m.id}/read`,{method:'POST'}).catch(()=>{})}}
function groupMessageRuns(messages){
  const groups=[];for(const m of messages){const last=groups.at(-1);const close=last&&last.sender_id===m.sender_id&&(new Date(m.created_at)-new Date(last.messages.at(-1).created_at))<=5*60*1000;if(close)last.messages.push(m);else groups.push({sender_id:m.sender_id,first_at:m.created_at,messages:[m]})}return groups;
}
function renderMessages(){
  const el=$('#messageList');if(!state.messages.length){el.innerHTML='<div class="empty chat-empty">NO MESSAGES YET</div>';return}
  const nearBottom=el.scrollHeight-el.scrollTop-el.clientHeight<100;
  el.innerHTML=groupMessageRuns(state.messages).map(g=>{
    const u=state.messageUsers[g.sender_id]||{display_name:g.sender_id===state.me.id?state.me.display_name:'USER',username:'user'};
    const own=g.sender_id===state.me.id;
    return `<section class="message-group ${own?'mine':''}">${avatarHtml(u,'msg-avatar')}<div class="message-stack"><div class="message-group-meta"><b>${esc(u.display_name)}</b><time>${esc(fmtDateTime(g.first_at))}</time></div>${g.messages.map((m,i)=>`<div class="message-line ${i?'continuation':''}" data-message="${m.id}"><div class="message-content">${m.deleted_at?'<em>MESSAGE DELETED</em>':linkify(m.content||'')}</div>${m.attachment_type==='image'&&m.attachment_url?`<a class="message-image-link" href="${esc(m.attachment_url)}" target="_blank" rel="noopener noreferrer"><img class="message-image" src="${esc(m.attachment_url)}" alt="${esc(m.attachment_name||'image')}" loading="lazy"></a>`:''}${(own||['admin','mod'].includes(state.me.role))?`<button class="message-delete" data-delete="${m.id}">×</button>`:''}</div>`).join('')}</div></section>`;
  }).join('');
  $$('#messageList [data-delete]').forEach(b=>b.onclick=()=>deleteMessage(b.dataset.delete));
  if(nearBottom||state.messages.length<8)el.scrollTop=el.scrollHeight;
}
async function sendMessage(e){e.preventDefault();if(!state.active)return;const content=$('#messageInput').value.trim();if(!content&&!state.pendingAttachment)return;const body=JSON.stringify({content,attachment:state.pendingAttachment});try{const url=state.active.type==='dm'?`/api/messages/${state.active.id}`:`/api/groups/${state.active.id}/messages`;await api(url,{method:'POST',body});$('#messageInput').value='';state.pendingAttachment=null;renderAttachmentDraft();resizeComposer();stopTyping()}catch{toast('SEND FAILED')}}
async function deleteMessage(id){if(!state.active)return;try{const url=state.active.type==='dm'?`/api/messages/${id}`:`/api/groups/${state.active.id}/messages/${id}`;await api(url,{method:'DELETE'})}catch{toast('DELETE FAILED')}}
function composerInput(){resizeComposer();if(!state.active||!state.socket)return;state.socket.emit('typing:start',{to:state.active.id,type:state.active.type});clearTimeout(state.typingTimer);state.typingTimer=setTimeout(stopTyping,900)}
function resizeComposer(){const el=$('#messageInput');el.style.height='auto';el.style.height=Math.min(120,el.scrollHeight)+'px'}
function stopTyping(){clearTimeout(state.typingTimer);if(state.active&&state.socket)state.socket.emit('typing:stop',{to:state.active.id,type:state.active.type})}
async function pingActive(){if(state.active?.type!=='dm')return;try{await api(`/api/ping/${state.active.id}`,{method:'POST'});toast('PING SENT')}catch(e){toast('PING BLOCKED',e.data?.retryAfter?`Try again in ${e.data.retryAfter}s.`:'Could not ping.')}}

function handlePasteImage(e){const items=[...(e.clipboardData?.items||[])];const item=items.find(x=>x.type.startsWith('image/'));if(item){e.preventDefault();const file=item.getAsFile();if(file)prepareAttachment(file)}}
function prepareAttachment(file){if(!file.type.startsWith('image/'))return toast('IMAGE ONLY');if(file.size>5*1024*1024)return toast('IMAGE TOO LARGE','Maximum 5 MB.');const reader=new FileReader();reader.onload=async()=>{toast('UPLOADING');try{const d=await api('/api/uploads/image',{method:'POST',body:JSON.stringify({dataUrl:reader.result,name:file.name})});state.pendingAttachment=d.attachment;renderAttachmentDraft()}catch{toast('UPLOAD FAILED')}};reader.readAsDataURL(file)}
function renderAttachmentDraft(){const el=$('#attachmentDraft');if(!state.pendingAttachment){el.classList.add('hidden');el.innerHTML='';return}el.classList.remove('hidden');el.innerHTML=`<img src="${esc(state.pendingAttachment.url)}" alt="preview"><span>${esc(state.pendingAttachment.name||'IMAGE')}</span><button id="removeAttachment" type="button">×</button>`;$('#removeAttachment').onclick=async()=>{const old=state.pendingAttachment;state.pendingAttachment=null;renderAttachmentDraft();if(old?.path)api('/api/uploads/image',{method:'DELETE',body:JSON.stringify({path:old.path})}).catch(()=>{})}}

function openNewGroup(){const friends=buckets().accepted.map(r=>r.user);if(!friends.length)return toast('ADD FRIENDS FIRST');openModal('NEW GROUP',`<form id="groupForm" class="modal-form"><label>GROUP NAME<input id="groupName" maxlength="40" placeholder="GROUP CHAT"></label><div class="select-list">${friends.map(u=>`<label class="select-user"><input type="checkbox" value="${u.id}">${avatarHtml(u)}<span><b>${esc(u.display_name)}</b><small>@${esc(u.username)}</small></span></label>`).join('')}</div><button class="primary" type="submit">CREATE GROUP</button></form>`);$('#groupForm').onsubmit=async e=>{e.preventDefault();const memberIds=$$('#groupForm input[type=checkbox]:checked').map(x=>x.value);if(!memberIds.length)return toast('CHOOSE A FRIEND');try{const d=await api('/api/groups',{method:'POST',body:JSON.stringify({name:$('#groupName').value,memberIds})});closeModal();await refreshConversations();openConversation('group',d.group.id)}catch{toast('GROUP FAILED')}}}

function openSettings(){openModal('SETTINGS',`<form id="settingsForm" class="modal-form"><label>DISPLAY NAME<input id="settingsDisplay" maxlength="40" value="${esc(state.me.display_name)}"></label><label>STATUS<input id="settingsCustom" maxlength="80" value="${esc(state.me.custom_status||'')}" placeholder="STATUS"></label><label>AVATAR URL<input id="settingsAvatarUrl" type="url" value="${esc(state.me.avatar_url||'')}" placeholder="HTTPS://"></label><div class="settings-actions">${['admin','mod'].includes(state.me.role)?'<button class="secondary" type="button" id="openAdminFromSettings">ADMIN PANEL</button>':''}<button class="primary" type="submit">SAVE</button><button class="danger" type="button" id="logoutBtn">LOG OUT</button></div></form>`);$('#settingsForm').onsubmit=saveSettings;$('#logoutBtn').onclick=logout;$('#openAdminFromSettings')?.addEventListener('click',()=>{closeModal();openAdminPanel()})}
async function saveSettings(e){e.preventDefault();try{const d=await api('/api/me',{method:'PATCH',body:JSON.stringify({displayName:$('#settingsDisplay').value,customStatus:$('#settingsCustom').value,avatarUrl:$('#settingsAvatarUrl').value})});state.me=d.user;renderMe();closeModal();toast('SAVED')}catch{toast('SAVE FAILED')}}
async function logout(){await api('/api/auth/logout',{method:'POST'});location.reload()}

async function openAdminPanel(){
  if(!['admin','mod'].includes(state.me.role))return;
  closeModal();
  const drawer=$('#adminDrawer');
  drawer.innerHTML=`<header class="admin-drawer-head"><b>${state.me.role==='admin'?'ADMIN PANEL':'MOD PANEL'}</b><button id="closeAdminDrawer" title="Close">×</button></header><div class="admin-tabs"><button class="active" data-admin-tab="users">USERS</button>${state.me.role==='admin'?'<button data-admin-tab="keys">KEYS</button>':''}</div><div id="adminBody" class="admin-drawer-body"></div>`;
  drawer.classList.remove('hidden');
  $('.messenger').classList.add('admin-open');
  $('#closeAdminDrawer').onclick=closeAdminPanel;
  $$('[data-admin-tab]').forEach(b=>b.onclick=()=>{$$('[data-admin-tab]').forEach(x=>x.classList.toggle('active',x===b));b.dataset.adminTab==='keys'?renderLicensePanel():renderUserAdmin()});
  renderUserAdmin();
}
function closeAdminPanel(){const drawer=$('#adminDrawer');if(!drawer)return;drawer.classList.add('hidden');drawer.innerHTML='';$('.messenger')?.classList.remove('admin-open')}
async function renderUserAdmin(q=''){
  const d=await api('/api/admin/users'+(q?`?q=${encodeURIComponent(q)}`:''));
  $('#adminBody').innerHTML=`<div class="admin-search"><input id="adminUserSearch" placeholder="SEARCH USERNAME OR NAME" value="${esc(q)}"><button id="adminSearchBtn">SEARCH</button></div><div class="admin-user-list">${d.users.map(u=>`<div class="admin-user">${avatarHtml(u)}<span class="admin-user-copy"><b>${esc(u.display_name)}</b><small>@${esc(u.username)} / ${esc(u.role.toUpperCase())}${u.is_banned?' / BANNED':''}</small></span><span class="admin-actions"><button data-viewchats="${u.id}" data-name="${esc(u.display_name)}">CHATS</button>${u.username!=='alex'?`<button data-ban="${u.id}" data-banned="${u.is_banned?'1':'0'}">${u.is_banned?'UNBAN':'BAN'}</button>${state.me.role==='admin'&&u.role!=='admin'?`<button data-role="${u.id}" data-next="${u.role==='mod'?'user':'mod'}">${u.role==='mod'?'REMOVE MOD':'MAKE MOD'}</button>`:''}`:''}</span></div>`).join('')||'<div class="empty">NO USERS</div>'}</div>`;
  $('#adminSearchBtn').onclick=()=>renderUserAdmin($('#adminUserSearch').value);$('#adminUserSearch').onkeydown=e=>{if(e.key==='Enter')renderUserAdmin($('#adminUserSearch').value)};
  $$('[data-ban]').forEach(b=>b.onclick=async()=>{const banning=b.dataset.banned!=='1';const reason=banning?prompt('Ban reason (optional):',''):'';try{await api(`/api/admin/users/${b.dataset.ban}`,{method:'PATCH',body:JSON.stringify({isBanned:banning,reason})});renderUserAdmin($('#adminUserSearch')?.value||'')}catch(e){toast('ACTION FAILED',e.message)}});
  $$('[data-role]').forEach(b=>b.onclick=async()=>{try{await api(`/api/admin/users/${b.dataset.role}`,{method:'PATCH',body:JSON.stringify({role:b.dataset.next})});renderUserAdmin($('#adminUserSearch')?.value||'')}catch(e){toast('ACTION FAILED',e.message)}});
  $$('[data-viewchats]').forEach(b=>b.onclick=()=>viewUserChats(b.dataset.viewchats,b.dataset.name));
}
async function viewUserChats(userId,name){const d=await api(`/api/admin/users/${userId}/conversations`);$('#adminBody').innerHTML=`<button id="adminBackUsers" class="back-line">← USERS</button><h3 class="admin-title">${esc(name)} / CHATS</h3><div class="inspect-list">${d.dms.map(u=>`<button data-inspectdm="${u.id}">${esc(u.display_name)} <small>@${esc(u.username)} / ${esc(fmtDateTime(u.last_at))}</small></button>`).join('')}${d.groups.map(g=>`<button data-inspectgroup="${g.id}"># ${esc(g.name)} <small>GROUP</small></button>`).join('')||'<div class="empty">NO CHAT HISTORY</div>'}</div>`;$('#adminBackUsers').onclick=()=>renderUserAdmin();$$('[data-inspectdm]').forEach(b=>b.onclick=()=>inspectDm(userId,b.dataset.inspectdm));$$('[data-inspectgroup]').forEach(b=>b.onclick=()=>inspectGroup(b.dataset.inspectgroup))}
async function inspectDm(a,b){const d=await api(`/api/admin/dm/${a}/${b}`);renderInspection(d.messages,d.users,'DM INSPECTION')}
async function inspectGroup(id){const d=await api(`/api/admin/group/${id}`);renderInspection(d.messages,d.users,'GROUP INSPECTION')}
function renderInspection(messages,users,title){const map=Object.fromEntries(users.map(u=>[u.id,u]));$('#adminBody').innerHTML=`<button id="inspectionBack" class="back-line">← BACK</button><h3 class="admin-title">${esc(title)}</h3><div class="inspection-messages">${groupMessageRuns(messages).map(g=>{const u=map[g.sender_id]||{display_name:'USER'};return `<div class="inspect-group"><b>${esc(u.display_name)}</b><small>${esc(fmtDateTime(g.first_at))}</small>${g.messages.map(m=>`<p>${linkify(m.content||'')}${m.attachment_url?`<br><a href="${esc(m.attachment_url)}" target="_blank">[IMAGE]</a>`:''}</p>`).join('')}</div>`}).join('')||'<div class="empty">NO MESSAGES</div>'}</div>`;$('#inspectionBack').onclick=()=>renderUserAdmin()}
async function renderLicensePanel(){const d=await api('/api/admin/licenses');$('#adminBody').innerHTML=`<form id="licenseForm" class="license-form"><input id="licenseLabel" maxlength="50" placeholder="LABEL / FRIEND NAME"><input id="licenseUses" type="number" min="1" max="50" value="3" title="Uses"><input id="licenseDays" type="number" min="1" max="365" value="30" title="Days"><button class="primary" type="submit">GENERATE KEY</button></form><div class="license-list">${d.keys.map(k=>`<div class="license-row"><span><b>${esc(k.label||'UNLABELED')}</b><small>${esc(k.key_prefix)}•••• / ${k.uses}/${k.max_uses} USES / ${k.expires_at?esc(fmtDateTime(k.expires_at)):'NO EXPIRY'}</small></span><button data-keytoggle="${k.id}" data-active="${k.is_active?'1':'0'}">${k.is_active?'REVOKE':'ENABLE'}</button></div>`).join('')||'<div class="empty">NO KEYS</div>'}</div>`;$('#licenseForm').onsubmit=async e=>{e.preventDefault();try{const r=await api('/api/admin/licenses',{method:'POST',body:JSON.stringify({label:$('#licenseLabel').value,maxUses:Number($('#licenseUses').value),days:Number($('#licenseDays').value)})});openKeyResult(r.key); }catch{toast('KEY FAILED')}};$$('[data-keytoggle]').forEach(b=>b.onclick=async()=>{await api(`/api/admin/licenses/${b.dataset.keytoggle}`,{method:'PATCH',body:JSON.stringify({isActive:b.dataset.active!=='1'})});renderLicensePanel()})}
function openKeyResult(key){openModal('LICENSE GENERATED',`<div class="key-result"><code>${esc(key)}</code><button id="copyKey" class="primary">COPY KEY</button><small>THIS FULL KEY IS SHOWN ONCE. SAVE IT NOW.</small></div>`);$('#copyKey').onclick=async()=>{await navigator.clipboard.writeText(key);toast('COPIED')}}

function openModal(title,html,size=''){const root=$('#modalRoot');root.innerHTML=`<section class="modal ${size}"><header class="modal-head"><b>${esc(title)}</b><button id="closeModal">×</button></header><div class="modal-body">${html}</div></section>`;root.classList.remove('hidden');$('#closeModal').onclick=closeModal;root.onclick=e=>{if(e.target===root)closeModal()}}
function closeModal(){$('#modalRoot').classList.add('hidden');$('#modalRoot').innerHTML=''}

function connectSocket(){
  if(state.socket)state.socket.disconnect();state.socket=io();
  state.socket.on('connect',()=>$('#connectionDot').classList.add('connected'));
  state.socket.on('disconnect',()=>$('#connectionDot').classList.remove('connected'));
  state.socket.on('message:new',m=>{if(state.active?.type==='dm'&&[m.sender_id,m.receiver_id].includes(state.active.id)&&[m.sender_id,m.receiver_id].includes(state.me.id)){if(!state.messages.some(x=>x.id===m.id)){state.messages.push(m);state.messages=state.messages.slice(-100);renderMessages()}if(m.receiver_id===state.me.id)api(`/api/messages/${m.id}/read`,{method:'POST'}).catch(()=>{})}refreshConversations()});
  state.socket.on('message:delete',({id})=>{state.messages=state.messages.filter(x=>x.id!==id);renderMessages();refreshConversations()});
  state.socket.on('group:message:new',m=>{if(state.active?.type==='group'&&state.active.id===m.group_id&&!state.messages.some(x=>x.id===m.id)){state.messages.push(m);state.messages=state.messages.slice(-100);if(!state.messageUsers[m.sender_id]){const member=state.active.members?.find(x=>x.id===m.sender_id);if(member)state.messageUsers[m.sender_id]=member}renderMessages()}refreshConversations()});
  state.socket.on('group:message:delete',({groupId,id})=>{if(state.active?.type==='group'&&state.active.id===groupId){state.messages=state.messages.filter(x=>x.id!==id);renderMessages()}refreshConversations()});
  state.socket.on('typing:start',({from,type,groupId})=>{if(state.active?.type==='dm'&&type==='dm'&&state.active.id===from)$('#typingLine').textContent=`${state.active.user.display_name} IS TYPING...`;if(state.active?.type==='group'&&type==='group'&&state.active.id===groupId){const u=state.active.members?.find(x=>x.id===from);if(u)$('#typingLine').textContent=`${u.display_name} IS TYPING...`}});
  state.socket.on('typing:stop',()=>$('#typingLine').textContent='');
  state.socket.on('presence:update',p=>{const update=u=>{if(u?.id===p.userId){u.status=p.status;u.last_seen=p.lastSeen}};state.relationships.forEach(r=>update(r.user));state.conversations.forEach(c=>{if(c.type==='dm')update(c.user)});renderFriends();renderConversations();if(state.active?.type==='dm'&&state.active.id===p.userId){update(state.active.user);$('#chatPresence').textContent=presenceText(state.active.user)}});
  state.socket.on('friends:update',refreshCore);state.socket.on('groups:update',refreshConversations);
  state.socket.on('ping',()=>{toast('PING','A FRIEND IS TRYING TO GET YOUR ATTENTION.');try{if(Notification.permission==='granted')new Notification('RELAY',{body:'A friend pinged you.'})}catch{}});
  state.socket.on('account:update',p=>{if(p.is_banned){toast('ACCOUNT BANNED');setTimeout(()=>location.reload(),1200)}else if(p.role&&p.role!==state.me.role){state.me.role=p.role;renderMe()}});
}
boot();
