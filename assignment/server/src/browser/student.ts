// @ts-nocheck
const pageConfig=JSON.parse(document.getElementById('pageConfig').textContent||'{}');
const rules=pageConfig.rules;
const approvalThresholdBytes=pageConfig.approvalThresholdBytes;
const approvalRequestPath=pageConfig.approvalRequestPath;
const submitPath=pageConfig.submitPath;
let selectedFiles=rules.map(()=>[]);
f.elements.name.oninput=()=>{f.elements.name.value=f.elements.name.value.replace(/\s+/g,'');};
function label(rule){return rule.name+(rule.required?' · 필수':' · 선택')+(rule.extension?' (.'+rule.extension+')':'');}
function limitText(rule){return (rule.extension?'.'+rule.extension:'모든 확장자')+' / 파일 1개';}
function renderFiles(){uploadGroups.innerHTML=rules.map((rule,groupIndex)=>{
 const rows=selectedFiles[groupIndex].map((file,fileIndex)=>'<div class="file-row"><span>'+file.name+'</span><button type="button" onclick="removeFile('+groupIndex+','+fileIndex+')">X</button></div>').join('')||'<p class="muted">선택한 파일이 없습니다.</p>';
 const accept=rule.extension?' accept=".'+rule.extension+'"':'';
 return '<div class="upload-rule"><div class="row" style="justify-content:space-between"><div><b>'+label(rule)+'</b><p class="muted">'+limitText(rule)+'</p></div><button type="button" class="secondary" onclick="document.getElementById(\'fileInput_'+groupIndex+'\').click()">파일 선택</button></div><input id="fileInput_'+groupIndex+'" type="file" '+accept+' hidden onchange="addFiles('+groupIndex+',this)">'+rows+'</div>';
}).join('');}
function addFiles(groupIndex,input){const file=(input.files||[])[0];if(file)selectedFiles[groupIndex]=[file];input.value='';renderFiles();}
function removeFile(groupIndex,fileIndex){selectedFiles[groupIndex].splice(fileIndex,1);renderFiles();}
noFile.onchange=()=>{fileSection.classList.toggle('uploads-disabled',noFile.checked);};
async function uploadSelected(approvalToken=''){msg.textContent='제출 중...';const fd=new FormData(f);fd.delete('files');if(approvalToken)fd.set('approvalToken',approvalToken);if(!noFile.checked)selectedFiles.forEach((files,groupIndex)=>files.forEach(file=>{fd.append('submissionSlotIds',rules[groupIndex].id);fd.append('files',file);}));const r=await fetch(submitPath,{method:'POST',body:fd});const data=await r.json().catch(()=>({error:'제출 실패'}));msg.textContent=r.ok?data.message:data.error;msg.className=r.ok?'ok':'danger';f.classList.remove('uploads-disabled');if(r.ok){f.reset();selectedFiles=rules.map(()=>[]);fileSection.classList.remove('uploads-disabled');renderFiles();}}
async function waitForApproval(token){for(;;){await new Promise(resolve=>setTimeout(resolve,1500));const r=await fetch('/api/public/submission-approvals/'+encodeURIComponent(token));const data=await r.json().catch(()=>({status:'error'}));if(data.status==='pending')continue;if(data.status==='approved'){await uploadSelected(token);return;}f.classList.remove('uploads-disabled');msg.textContent=data.status==='rejected'?'교사가 제출을 거부했습니다. 파일을 확인하거나 다시 선택해 주세요.':'승인 요청을 확인할 수 없습니다. 다시 제출해 주세요.';msg.className='danger';return;}}
f.onsubmit=async(e)=>{e.preventDefault();const allFiles=selectedFiles.flat();if(!noFile.checked&&allFiles.length===0){msg.textContent='파일을 추가하거나 파일 미제출을 체크하세요.';msg.className='danger';return;}if(!noFile.checked&&allFiles.some(file=>file.size>approvalThresholdBytes)){msg.textContent='제출 확인 중입니다. 교사의 승인 또는 거부를 기다려 주세요.';msg.className='muted';f.classList.add('uploads-disabled');const files=[];selectedFiles.forEach((items,groupIndex)=>items.forEach(file=>files.push({slotId:rules[groupIndex].id,filename:file.name,size:file.size})));const r=await fetch(approvalRequestPath,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({classNum:Number(f.elements.classNum.value),seatNum:Number(f.elements.seatNum.value),name:f.elements.name.value,files})});const data=await r.json().catch(()=>({error:'승인 요청 실패'}));if(!r.ok){f.classList.remove('uploads-disabled');msg.textContent=data.error;msg.className='danger';return;}await waitForApproval(data.token);return;}await uploadSelected();};
renderFiles();
