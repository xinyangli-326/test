const $ = id => document.getElementById(id);
const API_BASE = (window.TRIP_MALL_CONFIG?.API_BASE || '').replace(/\/$/, '');
const apiUrl = path => API_BASE + path;

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
  button.textContent = '研究中…';
  try {
    const response = await fetch(apiUrl('/api/research'), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ product:$('product').value, category_name:knowledge.categories[$('category').value].name, urls:[] }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    research = data.content;
    $('samples').value = `【联网研究】\n${research}\n\n${$('samples').value}`;
  } catch (error) { alert(`联网研究暂不可用：${error.message}`); }
  finally { button.textContent = '联网研究'; }
};
$('generate').onclick = async event => {
  const button = event.currentTarget;
  button.textContent = '生成中…';
  const payload = { category:$('category').value, product:$('product').value, persona:$('persona').value, channel:$('channel').value, content_type:$('contentType').value, extra:$('extra').value, research, style_samples:$('samples').value };
  try {
    const response = await fetch(apiUrl('/api/generate'), { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    $('result').textContent = data.content;
  } catch (error) { $('result').textContent = `生成暂不可用：${error.message}\n\n请通过 start.bat 启动后访问 http://127.0.0.1:8000。`; }
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
  const button=event.currentTarget; button.textContent='生成中…'; $('posterCopyStatus').textContent='正在根据知识库、目标和视角生成文案…';
  const fallback=localPosterCopy();
  try {
    const response=await fetch(apiUrl('/api/poster-copy'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({product:$('product').value,category_name:knowledge.categories[$('category').value].name,goal:$('posterGoal').value,persona:$('persona').value})});
    const data=await response.json(); if(!response.ok)throw new Error(data.error); applyPosterCopy(data); $('posterCopyStatus').textContent='AI海报文案已生成，每个文字层都可单独拖动和修改。';
  } catch(error) { applyPosterCopy(fallback); $('posterCopyStatus').textContent='已使用本地知识库生成文案；启动AI服务后可进一步优化。'; }
  finally { button.textContent='生成海报文案并自动排版'; }
};
$('addSticker').onclick=async event=>{const button=event.currentTarget;button.textContent='生成中…';try{const response=await fetch(apiUrl('/api/sticker'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subject:$('stickerPrompt').value})});const data=await response.json();if(!response.ok)throw new Error(data.error);const image=new Image();image.onload=()=>addObject({type:'image',image,x:760,y:850,width:image.width,height:image.height,scale:.35,rotation:0});image.src=data.image;}catch(error){alert(error.message);}finally{button.textContent='AI生成贴纸';}};
$('aiBg').onclick=async event=>{const button=event.currentTarget;button.textContent='生成中…';try{const response=await fetch(apiUrl('/api/poster'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({product:$('product').value,style:$('posterStyle').value,elements:$('stickerPrompt').value})});const data=await response.json();if(!response.ok)throw new Error(data.error);const image=new Image();image.onload=()=>{backgroundImage=image;draw();};image.src=data.image;}catch(error){alert(error.message);}finally{button.textContent='AI生成底图';}};
$('download').onclick=()=>{selected=null;draw();const anchor=document.createElement('a');anchor.download='TripMALL营销海报.png';anchor.href=canvas.toDataURL('image/png');anchor.click();};
applyPosterCopy(localPosterCopy());


