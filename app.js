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
    if (!response.ok || !contentType.includes('application/json')) {
      throw new Error(`公网API不可用（${response.status}）`);
    }
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
  if (!window.puter?.auth || !window.puter?.ai) {
    throw new Error('公共AI组件未加载，请按 Ctrl+F5 刷新页面');
  }
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
  const cleaned = String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('AI返回的JSON格式不完整');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/* ============================ 知识库 ============================ */

const LOCAL_CATEGORIES = {
  product: { name: '产品类知识库', content_types: ['专业知识','采购指南','优品推荐','优惠福利','内容互动','其他'], topics: ['宠物友好房','亲子房','影音房','舒睡房'] },
  platform: { name: '平台类知识库', content_types: ['功能科普','操作指南','问题解答','平台好物','旅拍合作','内容互动'], topics: ['下单流程','订单查询','售后申请','酒店用品推荐','旅拍合作'] },
  payment: { name: '支付类知识库', content_types: ['支付科普','付款指南','退款指南','免房置换','账单分期','风险提示'], topics: ['现金支付','对公转账','退款路径','免房置换','账单分期'] },
  campaign: { name: '活动类知识库', content_types: ['优惠福利','活动预热','倒计时','爆品推荐','限时促单','活动复盘'], topics: ['双11','618','酒店采购节','开业季','暑期亲子季'] },
  insight: { name: '干货类知识库', content_types: ['专业知识','运营清单','案例拆解','避坑指南','数据洞察','内容互动'], topics: ['酒店好评差评','酒店采购清单','前台常见问题','OTA运营','投诉处理'] }
};
const PERSONAS = ['酒店老板','店长','业主','总经理','收益总监','市场营销总监','酒店营销人员','酒店采购','酒店经理','销售总监','前厅经理','客房经理','财务总监','工程总监','品牌总监','投资人','酒店顾问','酒店供应商','一线销售','住客','宠物主','亲子家庭'];

let knowledge = { categories: LOCAL_CATEGORIES };
let research = '';

function renderSelectors() {
  $('category').innerHTML = Object.entries(knowledge.categories)
    .map(([key, value]) => `<option value="${key}">${value.name}</option>`).join('');
  $('persona').innerHTML = PERSONAS.map(value => `<option value="${value}">${value}</option>`).join('');
  renderContentTypes();
  renderCategoryCards();
}

function renderContentTypes() {
  const category = knowledge.categories[$('category').value] || LOCAL_CATEGORIES.product;
  $('contentType').innerHTML = category.content_types.map(value => `<option value="${value}">${value}</option>`).join('');
}

function renderCategoryCards() {
  $('categories').innerHTML = Object.values(knowledge.categories).map((value, index) => {
    const topics = Array.isArray(value.topics) ? value.topics : Object.keys(value.topics || {});
    return `<article class="cat reveal" style="transition-delay:${index * 70}ms">
      <b>${value.name}</b>
      <p>${value.description || '持续沉淀酒店行业可复用内容。'}</p>
      <ul>${topics.slice(0, 5).map(topic => `<li>${topic}</li>`).join('')}</ul>
    </article>`;
  }).join('');
  observeReveal();
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

/* ============================ 视觉滚动 ============================ */

function observeReveal() {
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('.reveal').forEach(el => el.classList.add('in'));
    return;
  }
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal:not(.in)').forEach(el => observer.observe(el));
}
observeReveal();

const heroImg = document.querySelector('.hero-img');
const nav = $('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 12);
  if (heroImg) {
    heroImg.style.transform = `translateY(${Math.min(70, window.scrollY * 0.07)}px) scale(1.04)`;
  }
}, { passive: true });

const TICKER_ITEMS = ['宠物友好房','亲子房','影音房','舒睡房','双11','618','酒店采购节','免房置换','账单分期','前台50问','OTA运营','开业筹备','投诉处理','暑期亲子季','旅拍合作'];
$('tickerTrack').innerHTML = [...TICKER_ITEMS, ...TICKER_ITEMS]
  .map(item => `<span>${item}</span>`).join('');

/* ============================ 个性化学习（持久化） ============================ */

const LS = {
  profile: 'tripMall.profile',
  materials: 'tripMall.materials',
  posterStyle: 'tripMall.posterStyle',
  posterMemory: 'tripMall.posterMemory',
  drafts: 'tripMall.drafts',
  needs: 'tripMall.needs'
};

function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

let materials = lsGet(LS.materials, []);
let drafts = lsGet(LS.drafts, []);
let posterMemory = lsGet(LS.posterMemory, []);

function renderLearnList() {
  $('learnList').innerHTML = materials.length ? materials.map(item => `
    <div class="learn-item">
      <input type="checkbox" data-id="${item.id}" ${item.checked ? 'checked' : ''}>
      <span class="badge">${item.type}</span>
      <span class="name" title="${escapeHtml(item.content.slice(0, 200))}">${escapeHtml(item.name)}</span>
      <button class="x" data-del="${item.id}" title="删除素材">×</button>
    </div>`).join('') : '<p class="empty">还没有学习素材，上传文件或粘贴链接后会自动加入。</p>';
  $('learnList').querySelectorAll('input[type=checkbox]').forEach(input => {
    input.onchange = () => {
      const item = materials.find(m => String(m.id) === input.dataset.id);
      if (item) { item.checked = input.checked; lsSet(LS.materials, materials); }
    };
  });
  $('learnList').querySelectorAll('.x').forEach(button => {
    button.onclick = () => {
      materials = materials.filter(m => String(m.id) !== button.dataset.del);
      lsSet(LS.materials, materials);
      renderLearnList();
    };
  });
}

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function addMaterial(item) {
  materials.unshift({
    id: Date.now(),
    name: item.name || '未命名素材',
    type: item.type || 'text',
    content: String(item.content || '').slice(0, 30000),
    checked: true,
    date: Date.now()
  });
  if (materials.length > 30) materials = materials.slice(0, 30);
  lsSet(LS.materials, materials);
  renderLearnList();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

$('learnFileBtn').onclick = async () => {
  const file = $('learnFile').files[0];
  if (!file) return alert('先选择要解析的文件（支持 txt/md/docx/pptx/pdf/html）');
  if (file.size > 10 * 1024 * 1024) return alert('文件过大，请压缩到10MB以内（PPT/Word含图时建议先压缩）；超大型文件请使用本机 server.py 运行。');
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  try {
    const data = await apiRequest('/api/extract', {
      filename: file.name,
      data_b64: await fileToBase64(file)
    }, 30000);
    addMaterial({ name: file.name, type: data.type || ext, content: data.content });
    alert(`已解析「${file.name}」，共 ${data.content.length} 字，已加入学习素材。`);
  } catch (error) {
    if (['txt', 'md', 'csv', 'json'].includes(ext)) {
      const content = await file.text();
      addMaterial({ name: file.name, type: ext, content });
      alert('已读取文本文件并加入学习素材。');
    } else {
      alert(`解析失败：${error.message}\n\n当前环境未连接后端API，docx/pptx/pdf 请在本机运行 server.py 或改用 txt/md 文本文件。`);
    }
  }
};

$('learnUrlBtn').onclick = async () => {
  const url = $('learnUrl').value.trim();
  if (!url) return alert('先粘贴要解析的链接');
  try {
    const data = await apiRequest('/api/extract', { url }, 30000);
    addMaterial({ name: url, type: 'link', content: data.content });
    alert(`已解析链接，共 ${data.content.length} 字，已加入学习素材。`);
  } catch (error) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const cleaned = text
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleaned.length < 50) throw new Error('提取内容过短');
      addMaterial({ name: url, type: 'link', content: cleaned });
      alert(`已在浏览器直接解析链接，共 ${cleaned.length} 字，已加入学习素材。`);
    } catch (fallbackError) {
      const hint = String(error.message).includes('OPENAI_API_KEY')
        ? '后端未配置 OPENAI_API_KEY，但链接解析不需要它——请刷新后重试或检查 Vercel 部署。'
        : '请确认链接可公开访问（公众号等需要登录的链接无法解析），或复制正文粘贴到“风格样本”。';
      alert(`解析链接失败：${error.message}\n\n${hint}`);
    }
  }
};

function checkedMaterialsText() {
  return materials.filter(m => m.checked)
    .map(m => `【${m.name}】\n${m.content.slice(0, 6000)}`)
    .join('\n\n')
    .slice(0, 16000);
}

$('learnProfile').onclick = async () => {
  const source = checkedMaterialsText();
  if (!source && !$('samples').value.trim()) {
    return alert('还没有学习素材：先上传文件/解析链接，或在“风格样本”粘贴文章。');
  }
  const fullSource = source
    ? source + '\n\n【手动粘贴样本】\n' + $('samples').value.slice(0, 8000)
    : $('samples').value.slice(0, 12000);
  const button = $('learnProfile');
  button.textContent = 'AI学习中…';
  const prompt = `你是资深中文文案编辑。从以下素材中提炼一份“风格画像”，让之后只凭简短提示词就能生成同风格内容。
素材：
${fullSource.slice(0, 20000)}
请输出中文风格画像，包含：1)整体语气；2)高频句式与开头方式；3)结构习惯；4)常用词与口头禅；5)内容长度与信息密度；6)最忌讳的写法（避免的AI腔）。400字以内，直接输出画像正文，不要Markdown标题。`;
  try {
    let profile;
    try {
      if (IS_GITHUB_PAGES) throw new Error('use puter');
      profile = (await apiRequest('/api/profile', { source: fullSource }, 30000)).content;
    } catch (apiError) {
      if (IS_GITHUB_PAGES) await ensurePuterAuth();
      profile = await puterChat(prompt);
    }
    $('profileBox').value = profile.trim();
    lsSet(LS.profile, profile.trim());
    alert('风格画像已生成，后续生成内容会自动遵循；可在文本框手动微调。');
  } catch (error) {
    alert(`生成风格画像失败：${error.message}`);
  } finally {
    button.textContent = 'AI学习：生成风格画像';
  }
};

$('learnReset').onclick = () => {
  if (!confirm('确认清空所有学习素材、风格画像、海报学习记录与草稿？')) return;
  materials = [];
  drafts = [];
  localStorage.removeItem(LS.materials);
  localStorage.removeItem(LS.profile);
  localStorage.removeItem(LS.posterStyle);
  localStorage.removeItem(LS.posterMemory);
  localStorage.removeItem(LS.drafts);
  posterMemory = [];
  $('profileBox').value = '';
  renderLearnList();
  renderPosterMemory();
  renderDraftCount();
  alert('已清空学习素材与画像。');
};

$('profileBox').value = lsGet(LS.profile, '');
$('profileBox').oninput = () => lsSet(LS.profile, $('profileBox').value);
renderLearnList();

/* 生成需求 chips */

function syncNeedTags() {
  const tags = [...document.querySelectorAll('#needChips button.on')].map(button => button.dataset.tag);
  const manualParts = $('needs').value.split(/[，,]/).map(s => s.trim())
    .filter(s => s && !tags.some(tag => s === tag || s.includes(tag)));
  $('needs').value = [...tags, ...manualParts].join('，');
  lsSet(LS.needs, tags);
}

const savedNeedTags = lsGet(LS.needs, []);
document.querySelectorAll('#needChips button').forEach(button => {
  if (savedNeedTags.includes(button.dataset.tag)) button.classList.add('on');
  button.onclick = () => {
    button.classList.toggle('on');
    syncNeedTags();
  };
});
$('needs').oninput = () => {
  const tags = [...document.querySelectorAll('#needChips button.on')].map(b => b.dataset.tag);
  lsSet(LS.needs, tags);
};

/* ============================ 联网研究 ============================ */

$('research').onclick = async event => {
  const button = event.currentTarget;
  button.textContent = '联网研究中…';
  const payload = {
    product: $('product').value,
    category_name: knowledge.categories[$('category').value].name,
    urls: []
  };
  try {
    if (IS_GITHUB_PAGES) await ensurePuterAuth();
    let content;
    try {
      if (IS_GITHUB_PAGES) throw new Error('使用公共AI');
      content = (await apiRequest('/api/research', payload, 20000)).content;
    } catch (apiError) {
      content = await puterChat(
        `请联网研究酒店行业主题“${payload.product}”，服务于${payload.category_name}内容创作。重点查找最新公开趋势、目标人群、竞品做法、社媒高互动选题、采购或运营问题。输出：可验证事实、来源、竞品启发、可执行选题、风险与数据口径。不要复制原文，不确定的信息要明确说明。`,
        { tools: [{ type: 'web_search' }] }
      );
    }
    research = content;
    $('samples').value = `【联网研究】\n${research}\n\n${$('samples').value}`;
    alert('联网研究完成，结果已写入风格样本区域。');
  } catch (error) {
    alert(`联网研究失败：${error.message}`);
  } finally {
    button.textContent = '联网研究';
  }
};

$('aiLogin').onclick = async () => {
  try {
    await ensurePuterAuth();
    alert('公共AI已连接，可开始生成。');
  } catch (error) {
    alert(`连接失败：${error.message}`);
  }
};

/* ============================ 内容生成 ============================ */

const CHANNEL_RULES = {
  '社群运营': '社群运营：150-200字左右，提炼内容精华，语气活泼、有“活人感”，像真实运营者在群里自然说话，允许口语化和少量语气词，结尾自然引导互动，不喊口号、不堆砌形容词。',
  '朋友圈': '朋友圈：输出3条180-350字长文案，像真人发的圈，有小故事感、场景感，不硬广。',
  '小红书': '小红书：完整种草或知识型成稿，含标题、正文、话题标签，真实体验感。',
  '公众号': '公众号：输出具体标题、导语、详细正文和CTA。',
  '销售话术': '销售话术：按真实沟通场景输出，含开场、需求挖掘、异议处理、促成动作。',
  '短视频口播': '短视频口播：脚本化，含钩子开场、节奏点、结尾引导，标注画面建议。',
  '内部提案': '内部提案：结构完整，含背景、方案、预算参考、风险与下一步。'
};

function buildGeneratePrompt(payload) {
  const categoryName = knowledge.categories[payload.category]?.name || payload.category;
  return `你是携程酒店服务市场的资深酒店营销专家，为酒店写真实、生动、可直接发布的中文内容。
知识库大类：${categoryName}；定义：${knowledge.categories[payload.category]?.description || ''}
产品/主题：${payload.product}
目标视角：${payload.persona}
发布渠道/文章类型：${payload.channel}
内容类型：${payload.content_type}
生成需求（个性化要求，务必逐一满足）：${payload.needs || '无'}
补充信息：${payload.extra || '无'}
联网研究：${payload.research || '无'}
文章风格样本：${String(payload.style_samples || '').slice(0, 12000)}
风格画像（AI学习总结，生成时严格遵循其语气、句式与结构习惯）：${String(payload.profile || '').slice(0, 6000)}
用户学习素材摘要（提炼要点融入，不要照抄原文）：${String(payload.materials || '').slice(0, 8000)}
渠道规则：${CHANNEL_RULES[payload.channel] || '按其使用场景输出完整成稿。'}
要求：
1. 具体回答覆盖人群、需求场景、痛点、产品价值、转化动作、指标和风险。
2. 遵循风格画像中的语气、句式与结构；没有画像时也避免AI腔，少用“值得注意的是”“综上所述”“在这个…的时代”等套话。
3. 若用户给出已有文案或细节要求（如调整细节、强调IP、强调功能、强调价格），先理解原意再改写，不丢失关键信息。
4. 内部数字写成参考值，不得编造平台规则。
输出：适用场景、核心钩子、完整正文、配图建议、CTA、风险提示。`;
}

$('generate').onclick = async event => {
  const button = event.currentTarget;
  button.textContent = 'AI生成中…';
  const payload = {
    category: $('category').value,
    product: $('product').value,
    persona: $('persona').value,
    channel: $('channel').value,
    content_type: $('contentType').value,
    extra: $('extra').value,
    needs: $('needs').value,
    research,
    style_samples: $('samples').value,
    profile: $('profileBox').value,
    materials: checkedMaterialsText()
  };
  try {
    if (IS_GITHUB_PAGES) await ensurePuterAuth();
    let content;
    try {
      if (IS_GITHUB_PAGES) throw new Error('使用公共AI');
      content = (await apiRequest('/api/generate', payload, 30000)).content;
    } catch (apiError) {
      content = await puterChat(buildGeneratePrompt(payload));
    }
    $('result').textContent = content;
  } catch (error) {
    $('result').textContent = `AI生成失败：${error.message}\n\n首次使用可能需要登录 Puter，请允许弹窗并完成登录。`;
  } finally {
    button.textContent = '生成具体内容 →';
  }
};

/* ============================ 海报画布 ============================ */

const canvas = $('c');
const ctx = canvas.getContext('2d');
let objects = [];
let selected = null;
let backgroundImage = null;
let backgroundInfo = null;
let dragState = null;
let watermarkEnabled = $('watermark').checked;

const logoImage = new Image();
logoImage.src = 'assets/trip-mall-logo-transparent.png?v=zbuild2';

function addObject(object) {
  snapshot();
  objects.push(object);
  selected = object;
  syncControls();
  draw();
  renderLayers();
}

function cover(image, x, y, w, h) {
  const ratio = Math.max(w / image.width, h / image.height);
  const sw = w / ratio;
  const sh = h / ratio;
  ctx.drawImage(image, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, x, y, w, h);
}

function drawWatermark() {
  if (!watermarkEnabled) return;
  if (logoImage.complete && logoImage.naturalWidth > 0) {
    const logoWidth = 170;
    const logoHeight = logoWidth * logoImage.naturalHeight / logoImage.naturalWidth;
    ctx.globalAlpha = 0.92;
    ctx.drawImage(logoImage, 44, 1778, logoWidth, logoHeight);
    ctx.globalAlpha = 1;
    ctx.font = '700 26px Microsoft YaHei';
    ctx.fillStyle = 'rgba(92,70,52,0.85)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('携程酒店服务市场', 44, 1778 + logoHeight + 30);
  } else {
    ctx.font = '700 28px Microsoft YaHei';
    ctx.fillStyle = 'rgba(92,70,52,0.85)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('携程酒店服务市场', 44, 1812);
  }
}

function draw() {
  const gradient = ctx.createLinearGradient(0, 0, 1080, 1920);
  gradient.addColorStop(0, '#fffdf9');
  gradient.addColorStop(1, '#dec5aa');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (backgroundImage) cover(backgroundImage, 0, 0, canvas.width, canvas.height);
  objects.forEach(object => {
    ctx.save();
    ctx.translate(object.x, object.y);
    ctx.rotate(object.rotation * Math.PI / 180);
    if (object.type === 'text') {
      ctx.font = `${object.weight || 700} ${object.size}px ${object.font}`;
      ctx.fillStyle = object.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(object.text, 0, 0);
      object.width = ctx.measureText(object.text).width;
      object.height = object.size * 1.25;
    } else {
      const width = object.width * object.scale;
      const height = object.height * object.scale;
      ctx.drawImage(object.image, -width / 2, -height / 2, width, height);
    }
    if (object === selected) {
      const b = bounds(object);
      ctx.strokeStyle = '#8c6846';
      ctx.lineWidth = 4;
      ctx.setLineDash([12, 8]);
      ctx.strokeRect(-b.width / 2, -b.height / 2, b.width, b.height);
      ctx.setLineDash([]);
    }
    ctx.restore();
  });
  drawWatermark();
}

function bounds(object) {
  return {
    width: object.type === 'text' ? object.width : object.width * object.scale,
    height: object.type === 'text' ? object.height : object.height * object.scale
  };
}

function pointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * canvas.width / rect.width,
    y: (event.clientY - rect.top) * canvas.height / rect.height
  };
}

function hit(object, x, y) {
  const b = bounds(object);
  return x > object.x - b.width / 2 && x < object.x + b.width / 2 &&
         y > object.y - b.height / 2 && y < object.y + b.height / 2;
}

let moved = false;
canvas.onpointerdown = event => {
  const point = pointerPosition(event);
  selected = [...objects].reverse().find(object => hit(object, point.x, point.y)) || null;
  moved = false;
  if (selected) dragState = { dx: point.x - selected.x, dy: point.y - selected.y };
  syncControls();
  draw();
  renderLayers();
};
canvas.onpointermove = event => {
  if (!dragState || !selected) return;
  const point = pointerPosition(event);
  selected.x = point.x - dragState.dx;
  selected.y = point.y - dragState.dy;
  moved = true;
  draw();
};
window.addEventListener('pointerup', () => {
  if (dragState && selected && moved) snapshot();
  dragState = null;
});
canvas.ondblclick = () => {
  if (!selected || selected.type !== 'text') return;
  const text = prompt('修改文本内容：', selected.text);
  if (text !== null && text.trim()) {
    snapshot();
    selected.text = text;
    draw();
  }
};
window.addEventListener('keydown', event => {
  const tag = (event.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag) || event.target.isContentEditable) return;
  if ((event.key === 'Delete' || event.key === 'Backspace') && selected) {
    event.preventDefault();
    deleteSelected();
  }
});

function syncControls() {
  if (!selected) return;
  $('size').value = selected.type === 'text'
    ? Math.min(180, selected.size)
    : Math.min(180, selected.scale * 100);
  $('rotate').value = selected.rotation;
  if (selected.color) $('color').value = selected.color;
  if (selected.font) $('font').value = selected.font;
}

function addText(text, x, y, size = 72, color = '#8c6846', font = 'Microsoft YaHei', weight = 700) {
  addObject({
    type: 'text', text, x, y, size, color, font, weight,
    rotation: 0, width: 400, height: size
  });
}

$('addText').onclick = () => addText($('newText').value, 540, 500, 90, $('color').value, $('font').value, 800);

$('size').oninput = event => {
  if (!selected) return;
  if (selected.type === 'text') selected.size = +event.target.value;
  else selected.scale = +event.target.value / 100;
  draw();
};
$('size').onchange = () => { if (selected) snapshot(); };
$('rotate').oninput = event => {
  if (selected) { selected.rotation = +event.target.value; draw(); }
};
$('rotate').onchange = () => { if (selected) snapshot(); };
$('color').oninput = event => {
  if (selected?.type === 'text') { selected.color = event.target.value; draw(); }
};
$('color').onchange = () => { if (selected) snapshot(); };
$('font').onchange = event => {
  if (selected?.type === 'text') { selected.font = event.target.value; draw(); snapshot(); }
};

function deleteSelected() {
  if (!selected) return;
  snapshot();
  objects = objects.filter(object => object !== selected);
  selected = null;
  draw();
  renderLayers();
}

$('delete').onclick = deleteSelected;
$('front').onclick = () => {
  if (!selected) return;
  snapshot();
  objects = objects.filter(object => object !== selected);
  objects.push(selected);
  draw();
  renderLayers();
};

function loadImageFile(file, callback) {
  if (!file) return;
  const image = new Image();
  image.onload = () => callback(image);
  image.src = URL.createObjectURL(file);
}

$('upload').onchange = event => loadImageFile(event.target.files[0], image => {
  addObject({
    type: 'image', image,
    x: 540, y: 1050,
    width: image.width, height: image.height,
    scale: Math.min(600 / image.width, 600 / image.height),
    rotation: 0
  });
  event.target.value = '';
});

/* 素材列表：点击 × 直接删除 */

function renderLayers() {
  $('layerList').innerHTML = objects.length ? objects.map((object, index) => {
    const label = object.type === 'text'
      ? (object.text || '文本').slice(0, 14)
      : '图片素材';
    return `<div class="layer-item ${object === selected ? 'on' : ''}" data-index="${index}">
      <span class="badge">${object.type === 'text' ? '文' : '图'}</span>
      <span class="name">${escapeHtml(label)}</span>
      <button class="x" data-del="${index}" title="直接删除该素材">×</button>
    </div>`;
  }).join('') : '<p class="empty">画布为空，添加文本、贴纸或图片后显示在这里。</p>';
  $('layerList').querySelectorAll('.layer-item').forEach(row => {
    row.onclick = event => {
      if (event.target.classList.contains('x')) return;
      selected = objects[+row.dataset.index] || null;
      syncControls();
      draw();
      renderLayers();
    };
  });
  $('layerList').querySelectorAll('.x').forEach(button => {
    button.onclick = () => {
      snapshot();
      objects = objects.filter((_, index) => index !== +button.dataset.del);
      selected = null;
      draw();
      renderLayers();
    };
  });
}

/* ============================ 撤销 / 重做 / 草稿 ============================ */

let historyStack = [];
let historyPos = -1;

function cloneState() {
  return {
    objects: objects.map(object => ({ ...object })),
    backgroundImage,
    backgroundInfo: backgroundInfo ? { ...backgroundInfo } : null
  };
}

function snapshot() {
  historyStack = historyStack.slice(0, historyPos + 1);
  historyStack.push(cloneState());
  if (historyStack.length > 40) historyStack.shift();
  historyPos = historyStack.length - 1;
  updateHistoryButtons();
}

function restoreState(state) {
  objects = state.objects.map(object => ({ ...object }));
  backgroundImage = state.backgroundImage;
  backgroundInfo = state.backgroundInfo ? { ...state.backgroundInfo } : null;
  selected = null;
  draw();
  renderLayers();
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $('undo').disabled = historyPos <= 0;
  $('redo').disabled = historyPos >= historyStack.length - 1;
}

$('undo').onclick = () => {
  if (historyPos <= 0) return;
  historyPos--;
  restoreState(historyStack[historyPos]);
};
$('redo').onclick = () => {
  if (historyPos >= historyStack.length - 1) return;
  historyPos++;
  restoreState(historyStack[historyPos]);
};

function serializeImage(image) {
  const temp = document.createElement('canvas');
  temp.width = image.naturalWidth || image.width;
  temp.height = image.naturalHeight || image.height;
  temp.getContext('2d').drawImage(image, 0, 0);
  return temp.toDataURL('image/png');
}

function imageFromDataURL(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

function renderDraftCount() {
  $('draftCount').textContent = drafts.length;
}

$('saveDraft').onclick = () => {
  if (!objects.length && !backgroundImage) return alert('画布为空，先添加内容再保存草稿。');
  const data = {
    objects: objects.map(object => object.type === 'image'
      ? { ...object, imageData: serializeImage(object.image) }
      : { ...object }),
    backgroundImage: backgroundImage ? serializeImage(backgroundImage) : null,
    backgroundInfo
  };
  drafts.unshift({
    id: Date.now(),
    name: `${$('newText').value || '未命名海报'} ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
    date: Date.now(),
    data
  });
  if (drafts.length > 15) drafts = drafts.slice(0, 15);
  lsSet(LS.drafts, drafts);
  renderDraftCount();
  alert('已保存草稿，可在“我的草稿”中恢复继续编辑。');
};

function renderDraftList() {
  $('draftList').innerHTML = drafts.length ? drafts.map(draft => `
    <div class="draft-item">
      <span class="name">${escapeHtml(draft.name)}</span>
      <span class="time">${new Date(draft.date).toLocaleString('zh-CN')}</span>
      <button data-restore="${draft.id}">恢复</button>
      <button class="x" data-del="${draft.id}" title="删除草稿">×</button>
    </div>`).join('') : '<p class="empty">还没有草稿。排版到一半时点击“存为草稿”，下次直接恢复。</p>';
  $('draftList').querySelectorAll('[data-restore]').forEach(button => {
    button.onclick = () => restoreDraft(+button.dataset.restore);
  });
  $('draftList').querySelectorAll('[data-del]').forEach(button => {
    button.onclick = () => {
      drafts = drafts.filter(draft => draft.id !== +button.dataset.del);
      lsSet(LS.drafts, drafts);
      renderDraftCount();
      renderDraftList();
    };
  });
}

async function restoreDraft(id) {
  const draft = drafts.find(item => item.id === id);
  if (!draft) return;
  try {
    const data = draft.data;
    const nextObjects = [];
    for (const object of data.objects) {
      if (object.type === 'image' && object.imageData) {
        nextObjects.push({ ...object, image: await imageFromDataURL(object.imageData) });
      } else {
        nextObjects.push({ ...object });
      }
    }
    snapshot();
    objects = nextObjects;
    backgroundImage = data.backgroundImage ? await imageFromDataURL(data.backgroundImage) : null;
    backgroundInfo = data.backgroundInfo ? { ...data.backgroundInfo } : null;
    selected = null;
    draw();
    renderLayers();
    $('draftModal').hidden = true;
    alert('草稿已恢复。');
  } catch (error) {
    alert(`恢复草稿失败：${error.message}`);
  }
}

$('openDrafts').onclick = () => {
  renderDraftList();
  $('draftModal').hidden = false;
};
$('closeDrafts').onclick = () => { $('draftModal').hidden = true; };
$('clearDrafts').onclick = () => {
  if (!confirm('确认清空所有草稿？')) return;
  drafts = [];
  lsSet(LS.drafts, drafts);
  renderDraftCount();
  renderDraftList();
};
renderDraftCount();

/* ============================ 海报文案 / 模板 ============================ */

function localPosterCopy() {
  const product = $('product').value || '酒店服务市场';
  const category = $('category').value;
  const goal = $('posterGoal').value;
  if (category === 'product') return {
    eyebrow: 'TRIP MALL 主题房升级', headline: product, subheadline: '一站式打造差异化卖点',
    price: goal === '产品招商' ? '轻量升级 · 快速上线' : '让特色房型更好卖',
    features: ['方案设计', '物资配置', '营销赋能'],
    metrics: [{ value: '省心', label: '一站采购' }, { value: '高效', label: '快速落地' }, { value: '专业', label: '服务保障' }],
    cta: '登录服务市场了解详情'
  };
  if (category === 'platform') return {
    eyebrow: '携程酒店服务市场', headline: product, subheadline: '酒店采购与服务，一站轻松完成',
    price: '平台好物 · 专业服务',
    features: ['快速搜索', '在线下单', '售后支持'],
    metrics: [{ value: '全', label: '品类丰富' }, { value: '快', label: '便捷下单' }, { value: '稳', label: '服务保障' }],
    cta: '立即进入服务市场'
  };
  if (category === 'payment') return {
    eyebrow: '灵活支付方案', headline: product, subheadline: '减轻现金流压力，采购安排更从容',
    price: '多种支付方式可选',
    features: ['对公支付', '账单分期', '免房置换'],
    metrics: [{ value: '灵活', label: '资金安排' }, { value: '清晰', label: '结算规则' }, { value: '省心', label: '服务支持' }],
    cta: '咨询适用支付方案'
  };
  if (category === 'campaign') return {
    eyebrow: 'TRIP MALL 限时活动', headline: product, subheadline: '酒店采购好物，限时优惠进行中',
    price: '限时福利 · 错过再等',
    features: ['爆品直降', '限时优惠', '酒店专享'],
    metrics: [{ value: '省', label: '采购成本' }, { value: '选', label: '热门好物' }, { value: '抢', label: '限时福利' }],
    cta: '立即查看活动会场'
  };
  return {
    eyebrow: '酒店运营实战干货', headline: product, subheadline: '一个问题，一套可落地的方法',
    price: '收藏备用 · 转发团队',
    features: ['问题拆解', '操作清单', '避坑建议'],
    metrics: [{ value: '懂', label: '经营逻辑' }, { value: '会', label: '操作方法' }, { value: '用', label: '落地清单' }],
    cta: '关注获取更多干货'
  };
}


function applyPosterCopy(copy, colors = { accent: '#c07c28', ink: '#8c6846', sub: '#5e4a39' }) {
  snapshot();
  objects = objects.filter(object => object.type !== 'text');
  addTextNoSnapshot(copy.eyebrow, 540, 130, 34, colors.ink, 'Microsoft YaHei', 700);
  addTextNoSnapshot(copy.headline, 540, 310, 118, colors.ink, 'SimHei', 900);
  addTextNoSnapshot(copy.subheadline, 540, 430, 40, colors.sub, 'Microsoft YaHei', 700);
  addTextNoSnapshot(copy.price, 540, 570, 52, colors.accent, 'Microsoft YaHei', 900);
  copy.features.forEach((text, index) => addTextNoSnapshot(text, 225 + index * 315, 1340, 38, colors.sub, 'Microsoft YaHei', 800));
  copy.metrics.forEach((item, index) => {
    addTextNoSnapshot(item.value, 225 + index * 315, 1545, 58, colors.accent, 'Microsoft YaHei', 900);
    addTextNoSnapshot(item.label, 225 + index * 315, 1610, 28, colors.sub, 'Microsoft YaHei', 600);
  });
  addTextNoSnapshot(copy.cta, 540, 1810, 38, '#ffffff', 'Microsoft YaHei', 800);
  selected = null;
  draw();
  renderLayers();
}

function addTextNoSnapshot(text, x, y, size, color, font, weight) {
  objects.push({ type: 'text', text, x, y, size, color, font, weight, rotation: 0, width: 400, height: size });
}

$('generatePosterCopy').onclick = async event => {
  const button = event.currentTarget;
  button.textContent = 'AI生成中…';
  $('posterCopyStatus').textContent = '正在生成海报标题、卖点和行动按钮…';
  const payload = {
    product: $('product').value,
    category_name: knowledge.categories[$('category').value].name,
    goal: $('posterGoal').value,
    persona: $('persona').value
  };
  try {
    if (IS_GITHUB_PAGES) await ensurePuterAuth();
    let copy;
    try {
      if (IS_GITHUB_PAGES) throw new Error('使用公共AI');
      copy = await apiRequest('/api/poster-copy', payload, 20000);
    } catch (apiError) {
      const prompt = `为Trip MALL携程酒店服务市场生成一套竖版营销海报短文案。产品：${payload.product}；知识库：${payload.category_name}；营销目标：${payload.goal}；目标视角：${payload.persona}。只返回JSON：{"eyebrow":"12字以内","headline":"14字以内","subheadline":"24字以内","price":"16字以内核心利益","features":["8字以内","8字以内","8字以内"],"metrics":[{"value":"短词或数字","label":"8字以内"},{"value":"短词或数字","label":"8字以内"},{"value":"短词或数字","label":"8字以内"}],"cta":"12字以内"}。没有可靠数字时用省心、专业、快速等利益点，不编造数据。`;
      copy = extractJson(await puterChat(prompt));
    }
    applyPosterCopy(copy);
    $('posterCopyStatus').textContent = 'AI海报文案已生成，每个文字层都可拖动和修改。';
  } catch (error) {
    applyPosterCopy(localPosterCopy());
    $('posterCopyStatus').textContent = `AI暂不可用，已使用本地知识库排版：${error.message}`;
  } finally {
    button.textContent = '生成海报文案并自动排版';
  }
};

/* ============================ 底图：AI / 上传 / 模板 ============================ */

$('bgMode').querySelectorAll('button').forEach(button => {
  button.onclick = () => {
    $('bgMode').querySelectorAll('button').forEach(b => b.classList.remove('on'));
    button.classList.add('on');
    $('bgAi').hidden = button.dataset.mode !== 'ai';
    $('bgUpload').hidden = button.dataset.mode !== 'upload';
  };
});

$('aiBg').onclick = async event => {
  const button = event.currentTarget;
  const payload = {
    product: $('product').value,
    style: $('posterStyle').value,
    scene: $('bgScene').value,
    description: $('bgDesc').value,
    elements: $('stickerPrompt').value
  };
  button.textContent = '生成底图中…';
  try {
    if (IS_GITHUB_PAGES) await ensurePuterAuth();
    let image;
    try {
      if (IS_GITHUB_PAGES) throw new Error('使用公共AI');
      const data = await apiRequest('/api/poster', payload, 30000);
      image = new Image();
      image.src = data.image;
      await image.decode();
    } catch (apiError) {
      if (!window.puter?.ai?.txt2img) throw new Error('Puter图片服务未加载');
      const sceneText = payload.scene ? `场景：${payload.scene}。` : '';
      const desc = payload.description
        ? `画面主体必须精确为：${payload.description}。`
        : '';
      image = await window.puter.ai.txt2img(
        `为${payload.product}生成9:16酒店营销海报底图，要求真实商业摄影质感（写实照片，不是插画、不是抽象画）。风格：${payload.style}。${sceneText}${desc}视觉元素：${payload.elements}。构图：主体清晰、居中偏下，上方和中央留出干净空白用于标题文字，柔和真实光线，高端酒店广告质感，香槟金#C39F77、暖白、深咖品牌配色。严禁出现：任何文字、字母、数字、水印、Logo、人脸、手部、畸形肢体、奇怪生物、抽象漂浮物、拼贴、漫画风。画面克制、真实、高级。`,
        { model: 'gpt-image-1', ratio: '9:16' }
      );
    }
    snapshot();
    backgroundImage = image;
    backgroundInfo = { mode: 'ai', style: payload.style, scene: payload.scene, description: payload.description };
    draw();
  } catch (error) {
    alert(`底图生成失败：${error.message}`);
  } finally {
    button.textContent = 'AI生成底图';
  }
};

let bgFileImage = null;
$('bgFile').onchange = event => {
  loadImageFile(event.target.files[0], image => {
    bgFileImage = image;
    $('bgPreview').innerHTML = `<img src="${image.src}" alt="底图预览">`;
  });
};
$('useBg').onclick = () => {
  if (!bgFileImage) return alert('先选择要上传的底图');
  snapshot();
  backgroundImage = bgFileImage;
  backgroundInfo = { mode: 'upload' };
  draw();
};
$('removeBg').onclick = () => {
  if (!backgroundImage) return;
  snapshot();
  backgroundImage = null;
  backgroundInfo = null;
  draw();
};

/* 海报记忆学习：投喂的参考海报长期保存，越投喂生成越接近 */

function renderPosterMemory() {
  $('posterMemoryCount').textContent = posterMemory.length;
  $('posterMemoryList').innerHTML = posterMemory.length ? posterMemory.map(item => `
    <div class="memory-item" title="${escapeHtml(item.name)}">
      <img src="${item.thumb}" alt="参考海报">
      <span class="nm">${escapeHtml(item.style?.style_name || item.name)}</span>
      <button class="del" data-del="${item.id}" title="删除这张记忆">×</button>
    </div>`).join('') : '<p class="empty">还没有投喂海报，上传参考海报后自动加入记忆库，投喂越多效果越好。</p>';
  $('posterMemoryList').querySelectorAll('.del').forEach(button => {
    button.onclick = () => {
      posterMemory = posterMemory.filter(item => item.id !== +button.dataset.del);
      lsSet(LS.posterMemory, posterMemory);
      renderPosterMemory();
    };
  });
}

function aggregatePosterStyle() {
  const styles = posterMemory.map(item => item.style).filter(Boolean);
  if (!styles.length) return null;
  const colors = [...new Set(styles.flatMap(s => s.colors || []))].filter(Boolean);
  const elements = [...new Set(styles.flatMap(s => s.key_elements || []))].slice(0, 6);
  const bgPrompts = styles.map(s => s.bg_prompt).filter(Boolean).join('; ').slice(0, 1500);
  return {
    style_name: `综合 ${styles.length} 张参考海报风格`,
    colors: colors.slice(0, 3),
    layout: styles.map(s => s.layout).filter(Boolean).join('；').slice(0, 300),
    key_elements: elements,
    bg_prompt: bgPrompts
  };
}

$('clearPosterMemory').onclick = () => {
  if (!confirm('确认清空海报学习记忆库？')) return;
  posterMemory = [];
  lsSet(LS.posterMemory, posterMemory);
  renderPosterMemory();
};
renderPosterMemory();

/* ============================ 贴纸生成（多风格） ============================ */

const STICKER_STYLE_DESC = {
  '卡通萌趣': 'cute cartoon style, big expressive eyes, bold clean outline, playful',
  '写实风': 'photorealistic style, natural lighting, soft shadows, detailed texture',
  '简洁风': 'minimal flat design, simple shapes, generous negative space, clean',
  '3D立体': 'soft 3D render style, glossy, rounded, subtle depth and lighting',
  '国潮插画': 'Chinese trend illustration style, ink wash accents, elegant patterns',
  '手绘涂鸦': 'hand-drawn doodle style, sketchy lines, casual, warm',
  '扁平极简': 'flat vector style, solid colors, geometric, modern'
};

$('addSticker').onclick = async event => {
  const button = event.currentTarget;
  const subject = $('stickerPrompt').value;
  const style = $('stickerStyle').value;
  const protectedNames = ['小黄人', '蛋仔派对', '迪士尼', '玲娜贝儿', '奥特曼', '宝可梦', '皮卡丘', '米老鼠', '星黛露', '库洛米'];
  if (protectedNames.some(name => subject.includes(name))) {
    return alert('商业IP请上传已授权透明PNG；AI只生成原创或通用角色。');
  }
  button.textContent = '生成贴纸中…';
  try {
    if (IS_GITHUB_PAGES) await ensurePuterAuth();
    let image;
    try {
      if (IS_GITHUB_PAGES) throw new Error('使用公共AI');
      const data = await apiRequest('/api/sticker', { subject, style }, 30000);
      image = new Image();
      image.src = data.image;
      await image.decode();
    } catch (apiError) {
      if (!window.puter?.ai?.txt2img) throw new Error('Puter图片服务未加载');
      const styleDesc = STICKER_STYLE_DESC[style] || STICKER_STYLE_DESC['卡通萌趣'];
      image = await window.puter.ai.txt2img(
        `原创贴纸，${style}：${subject}。${styleDesc}。透明背景，完整角色，粗线条轮廓，商业贴纸质感，无文字，无Logo，不模仿任何版权角色。`,
        { model: 'gpt-image-1', ratio: '1:1', transparent_background: true }
      );
    }
    addObject({
      type: 'image', image,
      x: 760, y: 850,
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      scale: 0.35, rotation: 0
    });
  } catch (error) {
    alert(`贴纸生成失败：${error.message}`);
  } finally {
    button.textContent = 'AI生成贴纸';
  }
};

/* ============================ 海报AI学习 ============================ */

function resizeImageFile(file, maxSide) {
  return new Promise((resolve, reject) => {
    loadImageFile(file, image => {
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const width = Math.round(image.width * scale);
      const height = Math.round(image.height * scale);
      const temp = document.createElement('canvas');
      temp.width = width;
      temp.height = height;
      temp.getContext('2d').drawImage(image, 0, 0, width, height);
      const mime = file.type.includes('png') ? 'image/png' : 'image/jpeg';
      resolve({ dataUrl: temp.toDataURL(mime, 0.9), mime });
    });
  });
}

async function puterVision(file) {
  if (!window.puter?.ai?.chat) throw new Error('公共AI不可用');
  const prompt = `分析这张酒店营销海报，只返回JSON：{"style_name":"一句话概括风格","colors":["#C39F77","#FFFFFF","#29231E"],"layout":"构图方式描述","font_feel":"字体气质","tone":"文案语气","key_elements":["元素1","元素2"],"bg_prompt":"用于AI生成类似风格底图的英文描述，要求9:16竖版、无文字、无Logo、无版权角色","layout_guide":"排版建议"}。不要复制海报上的具体文字内容。`;
  const response = await window.puter.ai.chat(prompt, { images: [file] });
  return extractJson(puterText(response));
}

function localStyleFromImage(image) {
  const temp = document.createElement('canvas');
  temp.width = 40;
  temp.height = 40;
  const g = temp.getContext('2d');
  g.drawImage(image, 0, 0, 40, 40);
  const data = g.getImageData(0, 0, 40, 40).data;
  const buckets = {};
  for (let i = 0; i < data.length; i += 16) {
    const key = `${data[i] >> 5},${data[i + 1] >> 5},${data[i + 2] >> 5}`;
    buckets[key] = (buckets[key] || 0) + 1;
  }
  const top = Object.entries(buckets).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([key]) => {
      const [r, g, b] = key.split(',').map(Number);
      const hex = [r, g, b].map(v => ((v << 5) | 15).toString(16).padStart(2, '0')).join('');
      return '#' + hex;
    });
  return {
    style_name: '自定义参考风格',
    colors: top,
    layout: '参考上传海报的构图',
    font_feel: '参考上传海报的字体气质',
    tone: '参考上传海报的文案语气',
    key_elements: [],
    bg_prompt: `vertical 9:16 hotel marketing poster background, dominant colors ${top.join(', ')}, premium hotel commercial feel, no text, no logo, clean copy zones`,
    layout_guide: ''
  };
}

$('learnPoster').onclick = async event => {
  const button = event.currentTarget;
  const file = $('refPoster').files[0];
  if (!file) return alert('先上传一张想学习的参考海报');
  button.textContent = 'AI学习中…';
  $('posterLearnStatus').textContent = '正在分析参考海报的风格…';
  try {
    const { dataUrl, mime } = await resizeImageFile(file, 1024);
    let style;
    try {
      if (IS_GITHUB_PAGES) throw new Error('use puter');
      style = await apiRequest('/api/poster-learn', {
        mime,
        data_b64: dataUrl.split(',')[1]
      }, 30000);
    } catch (apiError) {
      try {
        if (IS_GITHUB_PAGES) await ensurePuterAuth();
        style = await puterVision(file);
      } catch (visionError) {
        const image = new Image();
        image.src = dataUrl;
        await image.decode();
        style = localStyleFromImage(image);
        $('posterLearnStatus').textContent = 'AI视觉暂不可用，已用本地颜色分析兜底，可手动补充描述。';
      }
    }
    const thumb = await resizeImageFile(file, 180);
    posterMemory.unshift({
      id: Date.now(),
      name: file.name,
      date: Date.now(),
      thumb: thumb.dataUrl,
      style
    });
    if (posterMemory.length > 12) posterMemory = posterMemory.slice(0, 12);
    lsSet(LS.posterMemory, posterMemory);
    renderPosterMemory();
    lsSet(LS.posterStyle, style);

    const memoryStyle = aggregatePosterStyle() || style;
    const learnedCount = posterMemory.length;
    $('posterLearnStatus').textContent = `已学习第 ${learnedCount} 张参考海报（${memoryStyle.style_name}），正在生成相似底图…`;
    let bgImage;
    try {
      if (IS_GITHUB_PAGES) throw new Error('use puter');
      const data = await apiRequest('/api/poster', {
        product: $('product').value,
        style: memoryStyle.style_name || $('posterStyle').value,
        scene: '',
        description: `综合 ${learnedCount} 张参考海报风格：${memoryStyle.bg_prompt || memoryStyle.layout || ''}`,
        elements: (memoryStyle.key_elements || []).join('，')
      }, 30000);
      bgImage = new Image();
      bgImage.src = data.image;
      await bgImage.decode();
    } catch (apiError) {
      if (!window.puter?.ai?.txt2img) throw new Error('Puter图片服务未加载');
      const colorsText = (memoryStyle.colors || []).join('、') || '香槟金、暖白、深咖';
      const layoutText = memoryStyle.layout || '';
      const promptBase = memoryStyle.bg_prompt || '';
      bgImage = await window.puter.ai.txt2img(
        `综合 ${learnedCount} 张参考海报的风格，为"${$('product').value}"生成9:16酒店营销海报底图。
参考风格要点：风格名【${memoryStyle.style_name}】；主色【${colorsText}】；构图【${layoutText}】；视觉元素【${(memoryStyle.key_elements || []).join('、')}】；风格描述【${String(promptBase).slice(0, 900)}】。
要求：真实商业摄影/插画质感，主体清晰、居中偏下，上方留出干净空白放标题文字，柔和真实光线，高端酒店广告质感。严禁出现：文字、字母、数字、水印、Logo、人脸、手部、畸形肢体、奇怪生物、抽象漂浮物、拼贴、漫画风。画面克制、真实、高级。`,
        { model: 'gpt-image-1', ratio: '9:16' }
      );
    }
    snapshot();
    backgroundImage = bgImage;
    backgroundInfo = { mode: 'learn', style: memoryStyle.style_name };
    const colors = {
      accent: memoryStyle.colors?.[0] || '#c07c28',
      ink: memoryStyle.colors?.[1] || '#8c6846',
      sub: memoryStyle.colors?.[2] || '#5e4a39'
    };
    applyPosterCopy(localPosterCopy(), colors);
    $('posterLearnStatus').textContent = `完成！已综合 ${learnedCount} 张参考海报生成底图并排版，可继续拖动修改。投喂越多越接近你的风格。`;
  } catch (error) {
    $('posterLearnStatus').textContent = `海报学习失败：${error.message}`;
  } finally {
    button.textContent = 'AI学习并生成类似海报';
  }
};

/* ============================ 水印 / 下载 ============================ */

$('watermark').onchange = event => {
  watermarkEnabled = event.target.checked;
  draw();
};

$('download').onclick = () => {
  selected = null;
  draw();
  const anchor = document.createElement('a');
  anchor.download = 'TripMALL营销海报.png';
  anchor.href = canvas.toDataURL('image/png');
  anchor.click();
};

/* ============================ 初始化 ============================ */

updateHistoryButtons();
applyPosterCopy(localPosterCopy());
draw();
