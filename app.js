const $ = id => document.getElementById(id);
const API_BASE = (window.TRIP_MALL_CONFIG?.API_BASE || '').replace(/\/$/, '');
const apiUrl = path => API_BASE + path;

async function apiRequest(path, payload, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiUrl(path), {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload), signal: controller.signal
    });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.includes('application/json')) throw new Error(`公网API不可用（${response.status}）`);
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    return data;
  } finally { clearTimeout(timer); }
}
function puterText(response) {
  if (typeof response === 'string') return response;
  const content = response?.message?.content ?? response?.content ?? response?.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(item => item?.text || item?.content || '').join('\n');
  return String(response || '');
}
const IS_GITHUB_PAGES = window.location.hostname.endsWith('github.io');
function timeoutPromise(ms, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}
async function ensurePuterAuth() {
  if (!window.puter?.auth || !window.puter?.ai) throw new Error('公共AI组件未加载，请按 Ctrl+F5 刷新页面');
  const signedIn = await Promise.resolve(window.puter.auth.isSignedIn());
  if (!signedIn) {
    $('aiStatus').textContent = '公网AI：等待登录授权';
    await Promise.race([
      window.puter.auth.signIn(),
      timeoutPromise(30000, '登录窗口可能被拦截，请允许本站弹出窗口后点击“登录公共AI”')
    ]);
  }
  $('aiStatus').textContent = '公网AI：已连接';
}
async function puterChat(prompt, options = {}) {
  if (!window.puter?.ai?.chat) throw new Error('Puter AI 未加载，请刷新页面后重试');
  return puterText(await window.puter.ai.chat(prompt, options));
}
function extractJson(text) {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('AI返回的JSON格式不完整');
  return JSON.parse(cleaned.slice(start, end + 1));
}

const LOCAL_CATEGORIES = {
  product: { name: '产品类知识库', content_types: ['专业知识','采购指南','优品推荐','优惠福利','内容互动','其他'], topics: ['宠物友好房','亲子房','影音房','舒睡房'] },
  platform: { name: '平台类知识库', content_types: ['功能科普','操作指南','问题解答','平台好物','旅拍合作','内容互动'], topics: ['下单流程','订单查询','售后申请','酒店用品推荐','旅拍合作'] },
  payment: { name: '支付类知识库', content_types: ['支付科普','付款指南','退款指南','免房置换','账单分期','风险提示'], topics: ['现金支付','对公转账','退款路径','免房置换','账单分期'] },
  campaign: { name: '活动类知识库', content_types: ['优惠福利','活动预热','倒计时','爆品推荐','限时促单','活动复盘'], topics: ['双11','618','酒店采购节','开业季','暑期亲子季'] },
  insight: { name: '干货类知识库', content_types: ['专业知识','运营清单','案例拆解','避坑指南','数据洞察','内容互动'], topics: ['酒店好评差评','酒店采购清单','前台常见问题','OTA运营','投诉处理'] }
};
const PERSONAS = ['酒店老板','店长','业主','总经理','收益总监','市场营销总监','酒店采购','酒店经理','销售总监','前厅经理','客房经理','财务总监','工程总监','品牌总监','投资人','酒店顾问','酒店供应商','一线销售','住客','宠物主','亲子家庭'];
let knowledge = { categories: LOCAL_CATEGORIES };
let research = '';

function renderSelectors() {
  $('category').innerHTML = Object.entries(knowledge.categories).map(([key,value]) => `<option value="${key}">${value.name}</option>`).join('');
  $('persona').innerHTML = PERSONAS.map(value => `<option value="${value}">${value}</option>`).join('');
  renderContentTypes();
  renderCategoryCards();
}
function renderContentTypes() {
  const category = knowledge.categories[$('category').value] || LOCAL_CATEGORIES.product;
  $('contentType').innerHTML = category.content_types.map(value => `<option value="${value}">${value}</option>`).join('');
}
function renderCategoryCards() {
  $('categories').innerHTML = Object.values(knowledge.categories).map(value => {
    const topics = Array.isArray(value.topics) ? value.topics : Object.keys(value.topics || {});
    return `<article class="cat"><b>${value.name}</b><p>${value.description || '持续沉淀酒店行业可复用内容。'}</p><ul>${topics.slice(0,5).map(topic => `<li>${topic}</li>`).join('')}</ul></article>`;
  }).join('');
}
renderSelectors();
$('category').addEventListener('change', renderContentTypes);
fetch(apiUrl('/api/knowledge')).then(response => {
  if (!response.ok) throw new Error('knowledge unavailable');
  return response.json();
}).then(data => {
  if (data?.categories) {
    const selected = $('category').value;
    knowledge = data;
    renderSelectors();
    if (knowledge.categories[selected]) $('category').value = selected;
    renderContentTypes();
  }
}).catch(() => {});

$('research').onclick = async event => {
  const button = event.currentTarget;
  button.textContent = '联网研究中…';
  const payload = { product:$('product').value, category_name:knowledge.categories[$('category').value].name, urls:[] };
  try {
    if (IS_GITHUB_PAGES) await ensurePuterAuth();
    let content;
    try {
      if (IS_GITHUB_PAGES) throw new Error('使用公共AI');
      content = (await apiRequest('/api/research', payload, 8000)).content;
    } catch (apiError) {
      content = await puterChat(`请联网研究酒店行业主题“${payload.product}”，服务于${payload.category_name}内容创作。重点查找最新公开趋势、目标人群、竞品做法、社媒高互动选题、采购或运营问题。输出：可验证事实、来源、竞品启发、可执行选题、风险与数据口径。不要复制原文，不确定的信息要明确说明。`, {tools:[{type:'web_search'}]});
    }
    research = content;
    $('samples').value = `【联网研究】\n${research}\n\n${$('samples').value}`;
    alert('联网研究完成，结果已写入风格学习区域。');
  } catch (error) { alert(`联网研究失败：${error.message}`); }
  finally { button.textContent = '联网研究'; }
};
$('generate').onclick = async event => {
  const button = event.currentTarget;
  button.textContent = 'AI生成中…';
  const payload = { category:$('category').value, product:$('product').value, persona:$('persona').value, channel:$('channel').value, content_type:$('contentType').value, extra:$('extra').value, research, style_samples:$('samples').value };
  const categoryName = knowledge.categories[payload.category].name;
  try {
    if (IS_GITHUB_PAGES) await ensurePuterAuth();
    let content;
    try {
      if (IS_GITHUB_PAGES) throw new Error('使用公共AI');
      content = (await apiRequest('/api/generate', payload, 12000)).content;
    } catch (apiError) {
      const prompt = `你是携程酒店服务市场的资深酒店营销专家。请为以下任务生成具体、完整、可直接发布的中文内容。\n知识库：${categoryName}\n产品/主题：${payload.product}\n目标视角：${payload.persona}\n发布渠道：${payload.channel}\n内容类型：${payload.content_type}\n补充信息：${payload.extra || '无'}\n联网研究：${payload.research || '无'}\n风格样本：${payload.style_samples || '无'}\n要求：必须具体回答目标人群、真实场景、客户痛点、产品价值、转化动作、关键指标和风险。朋友圈输出3条180-350字长文案；小红书输出完整种草或知识型成稿；公众号输出具体标题、导语、详细正文和CTA；其他渠道按其使用场景输出完整成稿。内部数据写成参考值，不得编造平台规则。`;
      content = await puterChat(prompt);
    }
    $('result').textContent = content;
  } catch (error) { $('result').textContent = `AI生成失败：${error.message}\n\n首次使用可能需要登录 Puter，请允许弹窗并完成登录。`; }
  finally { button.textContent = '生成具体内容 →'; }
};

const canvas = $('c');
const ctx = canvas.getContext('2d');
let objects = [];
let selected = null;
let backgroundImage = null;
let dragState = null;

function addObject(object) { objects.push(object); selected = object; syncControls(); draw(); }
function cover(image,x,y,w,h) { const ratio=Math.max(w/image.width,h/image.height), sw=w/ratio, sh=h/ratio; ctx.drawImage(image,(image.width-sw)/2,(image.height-sh)/2,sw,sh,x,y,w,h); }
function draw() {
  const gradient = ctx.createLinearGradient(0,0,1080,1920);
  gradient.addColorStop(0,'#fffdf9'); gradient.addColorStop(1,'#dec5aa');
  ctx.fillStyle=gradient; ctx.fillRect(0,0,canvas.width,canvas.height);
  if (backgroundImage) cover(backgroundImage,0,0,canvas.width,canvas.height);
  objects.forEach(object => {
    ctx.save(); ctx.translate(object.x,object.y); ctx.rotate(object.rotation*Math.PI/180);
    if (object.type==='text') {
      ctx.font=`${object.weight || 700} ${object.size}px ${object.font}`; ctx.fillStyle=object.color; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(object.text,0,0); object.width=ctx.measureText(object.text).width; object.height=object.size*1.25;
    } else {
      const width=object.width*object.scale, height=object.height*object.scale;
      ctx.drawImage(object.image,-width/2,-height/2,width,height);
    }
    if (object===selected) {
      const width=object.type==='text'?object.width:object.width*object.scale;
      const height=object.type==='text'?object.height:object.height*object.scale;
      ctx.strokeStyle='#8c6846'; ctx.lineWidth=4; ctx.setLineDash([12,8]); ctx.strokeRect(-width/2,-height/2,width,height); ctx.setLineDash([]);
    }
    ctx.restore();
  });
}
function bounds(object) { return { width:object.type==='text'?object.width:object.width*object.scale, height:object.type==='text'?object.height:object.height*object.scale }; }
function pointerPosition(event) { const rect=canvas.getBoundingClientRect(); return { x:(event.clientX-rect.left)*canvas.width/rect.width, y:(event.clientY-rect.top)*canvas.height/rect.height }; }
function hit(object,x,y) { const b=bounds(object); return x>object.x-b.width/2 && x<object.x+b.width/2 && y>object.y-b.height/2 && y<object.y+b.height/2; }
canvas.onpointerdown = event => { const point=pointerPosition(event); selected=[...objects].reverse().find(object=>hit(object,point.x,point.y)) || null; if(selected) dragState={dx:point.x-selected.x,dy:point.y-selected.y}; syncControls(); draw(); };
canvas.onpointermove = event => { if(!dragState||!selected)return; const point=pointerPosition(event); selected.x=point.x-dragState.dx; selected.y=point.y-dragState.dy; draw(); };
window.addEventListener('pointerup',()=>dragState=null);
function syncControls() { if(!selected)return; $('size').value=selected.type==='text'?Math.min(180,selected.size):Math.min(180,selected.scale*100); $('rotate').value=selected.rotation; if(selected.color)$('color').value=selected.color; if(selected.font)$('font').value=selected.font; }
function addText(text,x,y,size=72,color='#8c6846',font='Microsoft YaHei',weight=700) { addObject({type:'text',text,x,y,size,color,font,weight,rotation:0,width:400,height:size}); }
$('addText').onclick=()=>addText($('newText').value,540,500,90,$('color').value,$('font').value,800);
$('size').oninput=event=>{if(!selected)return;if(selected.type==='text')selected.size=+event.target.value;else selected.scale=+event.target.value/100;draw();};
$('rotate').oninput=event=>{if(selected){selected.rotation=+event.target.value;draw();}};
$('color').oninput=event=>{if(selected?.type==='text'){selected.color=event.target.value;draw();}};
$('font').onchange=event=>{if(selected?.type==='text'){selected.font=event.target.value;draw();}};
$('delete').onclick=()=>{if(!selected)return;objects=objects.filter(object=>object!==selected);selected=null;draw();};
$('front').onclick=()=>{if(!selected)return;objects=objects.filter(object=>object!==selected);objects.push(selected);draw();};
function loadImageFile(file,callback){if(!file)return;const image=new Image();image.onload=()=>callback(image);image.src=URL.createObjectURL(file);}
$('upload').onchange=event=>loadImageFile(event.target.files[0],image=>addObject({type:'image',image,x:540,y:1050,width:image.width,height:image.height,scale:Math.min(600/image.width,600/image.height),rotation:0}));

function localPosterCopy() {
  const product=$('product').value || '酒店服务市场';
  const category=$('category').value;
  const goal=$('posterGoal').value;
  if(category==='product') return {eyebrow:'TRIP MALL 主题房升级',headline:product,subheadline:'一站式打造差异化卖点',price:goal==='产品招商'?'轻量升级 · 快速上线':'让特色房型更好卖',features:['方案设计','物资配置','营销赋能'],metrics:[{value:'省心',label:'一站采购'},{value:'高效',label:'快速落地'},{value:'专业',label:'服务保障'}],cta:'登录服务市场了解详情'};
  if(category==='platform') return {eyebrow:'携程酒店服务市场',headline:product,subheadline:'酒店采购与服务，一站轻松完成',price:'平台好物 · 专业服务',features:['快速搜索','在线下单','售后支持'],metrics:[{value:'全',label:'品类丰富'},{value:'快',label:'便捷下单'},{value:'稳',label:'服务保障'}],cta:'立即进入服务市场'};
  if(category==='payment') return {eyebrow:'灵活支付方案',headline:product,subheadline:'减轻现金流压力，采购安排更从容',price:'多种支付方式可选',features:['对公支付','账单分期','免房置换'],metrics:[{value:'灵活',label:'资金安排'},{value:'清晰',label:'结算规则'},{value:'省心',label:'服务支持'}],cta:'咨询适用支付方案'};
  if(category==='campaign') return {eyebrow:'TRIP MALL 限时活动',headline:product,subheadline:'酒店采购好物，限时优惠进行中',price:'限时福利 · 错过再等',features:['爆品直降','限时优惠','酒店专享'],metrics:[{value:'省',label:'采购成本'},{value:'选',label:'热门好物'},{value:'抢',label:'限时福利'}],cta:'立即查看活动会场'};
  return {eyebrow:'酒店运营实战干货',headline:product,subheadline:'一个问题，一套可落地的方法',price:'收藏备用 · 转发团队',features:['问题拆解','操作清单','避坑建议'],metrics:[{value:'懂',label:'经营逻辑'},{value:'会',label:'操作方法'},{value:'用',label:'落地清单'}],cta:'关注获取更多干货'};
}
function applyPosterCopy(copy) {
  objects=objects.filter(object=>object.type!=='text');
  addText(copy.eyebrow,540,130,34,'#8c6846','Microsoft YaHei',700);
  addText(copy.headline,540,310,118,'#8c6846','SimHei',900);
  addText(copy.subheadline,540,430,40,'#5e4a39','Microsoft YaHei',700);
  addText(copy.price,540,570,52,'#c07c28','Microsoft YaHei',900);
  copy.features.forEach((text,index)=>addText(text,225+index*315,1340,38,'#5a4535','Microsoft YaHei',800));
  copy.metrics.forEach((item,index)=>{addText(item.value,225+index*315,1545,58,'#c07c28','Microsoft YaHei',900);addText(item.label,225+index*315,1610,28,'#675447','Microsoft YaHei',600);});
  addText(copy.cta,540,1810,38,'#ffffff','Microsoft YaHei',800);
  selected=null; draw();
}
$('generatePosterCopy').onclick=async event=>{
  const button=event.currentTarget;
  button.textContent='AI生成中…';
  $('posterCopyStatus').textContent='正在生成海报标题、卖点和行动按钮…';
  const payload={product:$('product').value,category_name:knowledge.categories[$('category').value].name,goal:$('posterGoal').value,persona:$('persona').value};
  try {
    if (IS_GITHUB_PAGES) await ensurePuterAuth();
    let copy;
    try {
      if (IS_GITHUB_PAGES) throw new Error('使用公共AI');
      copy=await apiRequest('/api/poster-copy',payload,8000);
    } catch(apiError) {
      const prompt=`为Trip MALL携程酒店服务市场生成一套竖版营销海报短文案。产品：${payload.product}；知识库：${payload.category_name}；营销目标：${payload.goal}；目标视角：${payload.persona}。只返回JSON：{"eyebrow":"12字以内","headline":"14字以内","subheadline":"24字以内","price":"16字以内核心利益","features":["8字以内","8字以内","8字以内"],"metrics":[{"value":"短词或数字","label":"8字以内"},{"value":"短词或数字","label":"8字以内"},{"value":"短词或数字","label":"8字以内"}],"cta":"12字以内"}。没有可靠数字时用省心、专业、快速等利益点，不编造数据。`;
      copy=extractJson(await puterChat(prompt));
    }
    applyPosterCopy(copy);
    $('posterCopyStatus').textContent='AI海报文案已生成，每个文字层都可拖动和修改。';
  } catch(error) {
    applyPosterCopy(localPosterCopy());
    $('posterCopyStatus').textContent=`AI暂不可用，已使用本地知识库排版：${error.message}`;
  } finally { button.textContent='生成海报文案并自动排版'; }
};
$('addSticker').onclick=async event=>{
  const button=event.currentTarget, subject=$('stickerPrompt').value;
  const protectedNames=['小黄人','蛋仔派对','迪士尼','玲娜贝儿','奥特曼','宝可梦'];
  if(protectedNames.some(name=>subject.includes(name))) return alert('商业IP请上传已授权透明PNG；AI只生成原创或通用角色。');
  button.textContent='生成贴纸中…';
  try {
    if (IS_GITHUB_PAGES) await ensurePuterAuth();
    let image;
    try {
      if (IS_GITHUB_PAGES) throw new Error('使用公共AI');
      const data=await apiRequest('/api/sticker',{subject},15000);
      image=new Image(); image.src=data.image; await image.decode();
    } catch(apiError) {
      if(!window.puter?.ai?.txt2img) throw new Error('Puter图片服务未加载');
      image=await window.puter.ai.txt2img(`原创可爱贴纸：${subject}。透明背景，完整角色，粗线条轮廓，商业贴纸质感，无文字，无Logo，不模仿任何版权角色。`,{model:'gpt-image-1',ratio:'1:1',transparent_background:true});
    }
    addObject({type:'image',image,x:760,y:850,width:image.naturalWidth||image.width,height:image.naturalHeight||image.height,scale:.35,rotation:0});
  } catch(error){alert(`贴纸生成失败：${error.message}`);} finally {button.textContent='AI生成贴纸';}
};
$('aiBg').onclick=async event=>{
  const button=event.currentTarget;
  const payload={product:$('product').value,style:$('posterStyle').value,elements:$('stickerPrompt').value};
  button.textContent='生成底图中…';
  try {
    if (IS_GITHUB_PAGES) await ensurePuterAuth();
    let image;
    try {
      if (IS_GITHUB_PAGES) throw new Error('使用公共AI');
      const data=await apiRequest('/api/poster',payload,20000);
      image=new Image(); image.src=data.image; await image.decode();
    } catch(apiError) {
      if(!window.puter?.ai?.txt2img) throw new Error('Puter图片服务未加载');
      image=await window.puter.ai.txt2img(`为${payload.product}生成9:16酒店营销海报底图。风格：${payload.style}。视觉元素：${payload.elements}。Trip MALL香槟金、暖白、深咖配色，高级酒店商业广告质感，留出清晰中文文案区域，不出现任何文字、Logo或版权角色。`,{model:'gpt-image-1',ratio:'9:16'});
    }
    backgroundImage=image; draw();
  } catch(error){alert(`底图生成失败：${error.message}`);} finally {button.textContent='AI生成底图';}
};
$('download').onclick=()=>{selected=null;draw();const anchor=document.createElement('a');anchor.download='TripMALL营销海报.png';anchor.href=canvas.toDataURL('image/png');anchor.click();};
applyPosterCopy(localPosterCopy());





