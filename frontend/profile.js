/* profile.js – My Profile (form only) */
const _h=String(window.location.hostname||"").toLowerCase();
const _isLocal=_h==="localhost"||_h==="127.0.0.1"||_h.endsWith(".local")||/^192\.168\./.test(_h)||/^10\./.test(_h);
const API = "https://lively-reverence-production-def3.up.railway.app";
const getToken=()=>sessionStorage.getItem("token")||"";
const getRole=()=>sessionStorage.getItem("dmski_role")||"customer";
const authHdr=()=>({...{"Content-Type":"application/json"},Authorization:`Bearer ${getToken()}`});

document.addEventListener("DOMContentLoaded",async()=>{
  document.getElementById("copyrightYear").textContent=new Date().getFullYear();
  const token=getToken();
  if(!token){sessionStorage.removeItem("token");window.location.replace("/");return;}
  document.getElementById("logoutBtn").addEventListener("click",()=>{
    sessionStorage.removeItem("token");sessionStorage.removeItem("currentCaseId");window.location.href="/";
  });
  document.getElementById("authGate").style.display="none";
  document.getElementById("profileMain").style.display="";
  try{await loadProfile();}catch(err){
    if(err.status===401||err.status===403){sessionStorage.removeItem("token");window.location.replace("/");return;}
    showMsg(document.getElementById("profileMsg"),"Profil konnte nicht geladen werden.","error");
  }
  document.getElementById("profileForm").addEventListener("submit",onSave);
});

async function loadProfile(){
  const res=await fetch(`${API}/users/me`,{headers:authHdr()});
  if(res.status===401||res.status===403){const e=new Error();e.status=res.status;throw e;}
  if(!res.ok){const d=await res.json().catch(()=>({}));const e=new Error(d.error||"Fehler");e.status=res.status;throw e;}
  const {user}=await res.json();
  sessionStorage.setItem("dmski_role",user.role||"customer");
  sessionStorage.setItem("dmski_user_id",String(user.id));
  const letter=(user.first_name||user.email||"?")[0].toUpperCase();
  document.getElementById("avatarLetter").textContent=letter;
  document.getElementById("profileName").textContent=[user.first_name,user.last_name].filter(Boolean).join(" ")||user.email;
  document.getElementById("profileEmail").textContent=user.email;
  const badge=document.getElementById("profileBadge");
  const labels={admin:"Administrator",customer:"Fallinhaber",collaborator:"Fallreviewer"};
  badge.textContent=labels[user.role]||user.role;
  badge.className=`badge-role badge-${user.role||"customer"}`;
  document.getElementById("fieldFirstName").value=user.first_name||"";
  document.getElementById("fieldLastName").value=user.last_name||"";
  document.getElementById("fieldEmail").value=user.email||"";
  document.getElementById("fieldAddress").value=user.address||"";
  document.getElementById("fieldMobile").value=user.mobile||"";
  if(user.role==="collaborator"){
    const g=document.getElementById("fieldFunctionGroup");
    const s=document.getElementById("fieldFunction");
    if(g)g.style.display="";
    if(s&&user.function_label)s.value=user.function_label;
  }
}

async function onSave(e){
  e.preventDefault();
  const btn=e.target.querySelector("button[type=submit]");
  const msg=document.getElementById("profileMsg");
  showMsg(msg,"");
  const np=document.getElementById("fieldNewPwd").value.trim();
  const np2=document.getElementById("fieldNewPwd2").value.trim();
  const cp=document.getElementById("fieldCurrentPwd").value;
  if(np&&np!==np2){showMsg(msg,"Die neuen Passwörter stimmen nicht überein.","error");return;}
  const body={
    email:document.getElementById("fieldEmail").value.trim(),
    first_name:document.getElementById("fieldFirstName").value.trim(),
    last_name:document.getElementById("fieldLastName").value.trim(),
    address:document.getElementById("fieldAddress").value.trim(),
    mobile:document.getElementById("fieldMobile").value.trim(),
  };
  if(np){body.password=np;body.currentPassword=cp;}
  const fg=document.getElementById("fieldFunctionGroup");
  if(fg&&fg.style.display!=="none")body.function_label=document.getElementById("fieldFunction").value||"";
  if(btn){btn.disabled=true;btn.textContent="Speichert …";}
  try{
    const res=await fetch(`${API}/users/me`,{method:"PATCH",headers:authHdr(),body:JSON.stringify(body)});
    const data=await res.json();
    if(!res.ok){showMsg(msg,data.error||"Fehler.","error");return;}
    showMsg(msg,"✓ Profil erfolgreich gespeichert.","success");
    ["fieldCurrentPwd","fieldNewPwd","fieldNewPwd2"].forEach(id=>(document.getElementById(id).value=""));
    await loadProfile();
  }catch{showMsg(msg,"Netzwerkfehler.","error");}
  finally{if(btn){btn.disabled=false;btn.textContent="Speichern";}}
}

function showMsg(el,text,type=""){
  el.textContent=text;
  el.className=`message${type?` message--${type}`:""}`;
}
