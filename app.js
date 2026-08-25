const missingEl = new Proxy(function () {}, {
  get: () => missingEl,
  set: () => true,
  apply: () => missingEl
});
const $ = id => document.getElementById(id) || missingEl;
// 脱敏：从任意文本中抹掉 API Key / 令牌片段，避免错误信息回显 Key
function maskSecrets(text, extraKeys = []) {
  let out = String(text || '');
  const collect = [];
  try { collect.push(...Object.values(getAIConfig() || {})); } catch {}
  try { collect.push(...Object.values(getImageConfig() || {})); } catch {}
  collect.push(...extraKeys);
  const candidates = collect
    .filter(v => typeof v === 'string' && v.length >= 12 && /[A-Za-z0-9_-]/.test(v))
    .map(v => v.trim())
    .filter(Boolean);
  for (const key of candidates) {
    try {
      const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(esc, 'g'), key.slice(0, 4) + '…' + key.slice(-4));
    } catch {}
  }
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{12,}|sk-sp-[A-Za-z0-9_-]{12,}|sk-ws-[A-Za-z0-9_-]{12,}|LTAI[A-Za-z0-9]{16,})\b/g,
    m => m.slice(0, 4) + '…' + m.slice(-4));
  return out;
}
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

/* ============================ 自填 API Key（OpenAI 兼容，浏览器直连） ============================ */

const AI_PROVIDERS = {
  deepseek: {
    name: 'DeepSeek（推荐）', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', imageModel: '',
    models: ['deepseek-chat', 'deepseek-reasoner'], recommend: 'deepseek-chat'
  },
  siliconflow: {
    name: '硅基流动', base: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3', imageModel: 'black-forest-labs/FLUX.1-schnell',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'Qwen/Qwen2.5-7B-Instruct'], recommend: 'deepseek-ai/DeepSeek-V3'
  },
  zhipu: {
    name: '智谱GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', imageModel: '',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'], recommend: 'glm-4-plus'
  },
  moonshot: {
    name: 'Kimi（月之暗面）', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k', imageModel: '',
    models: ['moonshot-v1-32k', 'moonshot-v1-8k', 'kimi-latest'], recommend: 'moonshot-v1-32k'
  },
  dashscope: {
    name: '阿里云百炼（通义）', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max', imageModel: '',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'], recommend: 'qwen-max'
  },
  qianwen: {
    name: '千问AI平台 Token Plan（月付套餐）', base: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max', imageModel: 'qwen-image-3.0-pro',
    models: ['qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'glm-5.2'], recommend: 'qwen3.8-max'
  },
  openai: {
    name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o', imageModel: 'gpt-image-1',
    models: ['gpt-4o', 'gpt-4o-mini'], recommend: 'gpt-4o'
  },
  custom: { name: '自定义', base: '', model: '', imageModel: '', models: [], recommend: '' }
};

const AI_KEY = 'tripMall.aiConfig';

function getAIConfig() {
  return lsGet(AI_KEY, { mode: 'vercel', provider: 'deepseek', apiKey: '', model: '', baseUrl: '' });
}

function hasByok() {
  const cfg = getAIConfig();
  return cfg.mode === 'byok' && !!cfg.apiKey;
}

function getImageConfig() {
  const cfg = getAIConfig();
  if (cfg.mode !== 'byok') return null;
  let providerKey = cfg.imageProvider || cfg.provider;
  const provider = AI_PROVIDERS[providerKey] || AI_PROVIDERS.custom;
  let key = cfg.imageKey || '';
  // 百炼/Token Plan：文字服务商同名时才可复用文字 Key；否则必须单独填专属图片 Key（不能把 DeepSeek/硅基的 Key 发过去）
  if (!key && (providerKey === 'dashscope' || providerKey === 'qianwen') && cfg.provider === providerKey) key = cfg.apiKey || '';
  if (!key && providerKey !== 'dashscope' && providerKey !== 'qianwen') key = cfg.apiKey || '';
  if (!key) return null;
  if (providerKey === 'dashscope' && /^sk-sp-/i.test(key)) providerKey = 'qianwen'; // Token Plan 专属 Key 自动识别
  // Token Plan：sk-sp- Key 只认 token-plan 域名；旧配置里若还留着百炼地址则强制换回默认地址
  const base = providerKey === 'qianwen'
    ? (String(cfg.imageBaseUrl || '').includes('token-plan') ? cfg.imageBaseUrl : 'https://token-plan.cn-beijing.maas.aliyuncs.com')
    : (cfg.imageBaseUrl || provider.base);
  const model = cfg.imageModel || (providerKey === 'qianwen' ? 'qwen-image-3.0-pro' : provider.imageModel);
  if (!model) return null;
  return { provider: providerKey, base, key, model };
}

function hasByokImage() {
  return !!getImageConfig();
}

function imageConfigError() {
  const cfg = getAIConfig();
  if (cfg.mode !== 'byok') return '未配置自填 AI：请在「AI 设置」里开启自填 AI 并填写服务商与 Key。';
  const providerKey = cfg.imageProvider || cfg.provider;
  if ((providerKey === 'dashscope' || providerKey === 'qianwen') && !(cfg.imageKey || (cfg.provider === providerKey && cfg.apiKey))) {
    return providerKey === 'qianwen'
      ? 'Token Plan 图片 Key 未配置：AI 设置 → 图片生成 → 图片服务商选「千问AI平台 Token Plan（月付套餐）」，图片 API Key 填千问AI平台 Token Plan 页面里的专属 Key（sk-sp- 开头）。'
      : '百炼图片 Key 未配置：AI 设置 → 图片生成 → 图片 API Key 需单独填百炼控制台里 sk- 开头的 Key（不能复用 DeepSeek/硅基的文字 Key，否则报 InvalidApiKey）。';
  }
  const provider = AI_PROVIDERS[providerKey] || AI_PROVIDERS.custom;
  if (!cfg.imageModel && !provider.imageModel) {
    return `图片模型未配置：请在「AI 设置」里填写图片模型（${providerKey === 'dashscope' || providerKey === 'qianwen' ? '推荐 qwen-image-3.0-pro' : '如 black-forest-labs/FLUX.1-schnell'}）。`;
  }
  return '未配置图片生成：请先在「AI 设置」里把图片服务商设为阿里云百炼 / 千问AI平台 Token Plan（月付套餐）或智谱 CogView 并填写 Key。';
}

async function openAILikeChat(system, user, { maxTokens = 3000, temperature = 0.85 } = {}) {
  const cfg = getAIConfig();
  const provider = AI_PROVIDERS[cfg.provider] || AI_PROVIDERS.custom;
  // Token Plan 接口未开放浏览器跨域，文本统一走服务端中转
  if (cfg.provider === 'qianwen') {
    if (!API_BASE) throw new Error('Token Plan 文本接口需要服务端中转，请在部署环境中使用（当前页面未配置 API_BASE）。');
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user });
    let response;
    try {
      response = await fetch(apiUrl('/api/token-plan-chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: cfg.apiKey,
          model: cfg.model || provider.model,
          messages,
          max_tokens: maxTokens,
          temperature
        })
      });
    } catch (fetchError) {
      throw new Error(
        `Token Plan 文本中转连接失败（${fetchError.message || 'Failed to fetch'}）：当前网络访问不了中转域名 ${API_BASE}。建议把文字服务商改回 DeepSeek / 硅基流动 / 百炼按量（浏览器直连、不走中转）；月付套餐请在公司等能访问 vercel.app 的网络下使用。`
      );
    }
    if (!response.ok) {
      const ct = response.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Token Plan 文本中转错误（${response.status}）`);
      }
      throw new Error(`Token Plan 文本中转错误（${response.status}，非 JSON 响应，可能被 Vercel 部署保护拦截，需到 vercel.com 关闭 Deployment Protection）`);
    }
    const data = await response.json();
    if (data.content) return data.content;
    throw new Error('Token Plan 返回内容为空');
  }
  const base = (cfg.baseUrl || provider.base).replace(/\/+$/, '');
  if (!base) throw new Error('请先在 AI 设置里填写接口地址');
  const model = cfg.model || provider.model || 'gpt-4o-mini';
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const response = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`AI接口错误（${response.status}）：${maskSecrets(String(text).slice(0, 200), [cfg.apiKey])}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 返回内容为空');
  return content;
}

async function dashscopeImage(prompt, { aspect = 'square', reference = null, size = '' } = {}) {
  const img = getImageConfig();
  const isTokenPlan = img.provider === 'qianwen';
  const providerLabel = isTokenPlan ? 'Token Plan' : '百炼';
  const isEdit = !!reference;
  const isV3 = /3\.0/i.test(img.model || '');
  let model;
  if (isV3) {
    model = img.model; // qwen-image-3.0 / 3.0-pro 统一支持文生图与参考图编辑
  } else if (isEdit) {
    model = /edit/i.test(img.model) ? img.model : 'qwen-image-edit';
  } else {
    model = img.model || 'qwen-image';
  }
  const content = [];
  if (isEdit) content.push({ image: reference });
  content.push({ text: prompt });
  const parameters = { watermark: false };
  if (isV3) {
    // 完全按官方 3.0 参考：不传 size（模型按提示词自动推荐高清分辨率，pro 对 size 校验严格）、开启提示词增强
    parameters.prompt_extend = true;
  } else {
    // Token Plan 官方示例与旧版 qwen-image 都支持 size；参考图编辑时百炼 qwen-image-edit 不传 size
    if (!isEdit || isTokenPlan) {
      parameters.size = aspect === '9:16' ? '720*1280' : (aspect === '16:9' ? '1280*720' : '1024*1024');
    }
    if (!isEdit) {
      parameters.negative_prompt = '低质量、模糊、畸形、水印、杂乱构图、乱码';
    }
  }
  // Token Plan 接口未开放浏览器跨域（官方设计给服务端工具用），优先走网站自带中转；
  // 中转不可用时才尝试直连（直连在浏览器里通常会因跨域失败）
  let proxyError = null;
  if (isTokenPlan && API_BASE) {
    try {
      const proxyResp = await fetch(apiUrl('/api/token-plan-image'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: img.key,
          model,
          prompt,
          reference: isEdit ? reference : '',
          size: parameters.size || '',
          prompt_extend: !!parameters.prompt_extend,
          watermark: parameters.watermark !== false
        })
      });
      if (proxyResp.ok) {
        const proxyCt = proxyResp.headers.get('content-type') || '';
        if (!proxyCt.includes('application/json')) {
          throw new Error('中转后端返回的不是 JSON（可能被 Vercel 部署保护/认证页拦截，需到 vercel.com 关闭 Deployment Protection）');
        }
        const proxyData = await proxyResp.json();
        if (proxyData.image) {
          return proxyData.image.startsWith('data:') ? proxyData.image : toSafeDataURL(proxyData.image);
        }
        throw new Error(proxyData.error || '中转未返回图片');
      }
      const proxyCt = proxyResp.headers.get('content-type') || '';
      if (proxyCt.includes('application/json')) {
        const proxyErr = await proxyResp.json().catch(() => ({}));
        throw new Error(proxyErr.error || `中转接口错误（${proxyResp.status}）`);
      }
      throw new Error(`中转接口错误（${proxyResp.status}，非 JSON 响应，可能被 Vercel 部署保护拦截）`);
    } catch (error) {
      proxyError = error;
    }
  }
  // Token Plan：sk-sp- 专属 Key 只认 token-plan 域名，绝不回退百炼通用域名；
  // 百炼：自定义地址（业务空间专属域名等）→ 国内版 → 国际版；401 时自动换域名重试
  const bases = isTokenPlan
    ? [img.base]
    : [img.base, 'https://dashscope.aliyuncs.com', 'https://dashscope-intl.aliyuncs.com'];
  const endpoints = [...new Set(bases
    .map(b => String(b || '').replace(/\/+$/, '').replace(/\/compatible-mode(\/v1)?$/, ''))
    .filter(b => /^https?:\/\//i.test(b))
    .map(b => b + '/api/v1/services/aigc/multimodal-generation/generation'))];
  const call = (endpoint, params) => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + img.key },
    body: JSON.stringify({
      model,
      input: { messages: [{ role: 'user', content }] },
      parameters: params
    })
  });
  let response = null;
  let usedEndpoint = endpoints[0];
  for (const endpoint of endpoints) {
    try {
      response = await call(endpoint, parameters);
    } catch (error) {
      response = null; // 网络/跨域失败，换下一个域名
      usedEndpoint = endpoint;
      continue;
    }
    usedEndpoint = endpoint;
    if (response.ok) break;
    if (response.status !== 401) break; // 仅鉴权失败才换域名，其他错误直接返回
  }
  // 参数降级重试：先去 prompt_extend，再去 watermark，避免 Token Plan/百炼个别参数校验严格
  if (response && !response.ok && response.status !== 401) {
    const attempts = [parameters];
    const last = attempts[attempts.length - 1];
    if (isV3 && last.prompt_extend) attempts.push({ ...last, prompt_extend: false });
    if (attempts[attempts.length - 1].watermark) attempts.push({ ...attempts[attempts.length - 1], watermark: false });
    for (const params of attempts.slice(1)) {
      const retry = await call(usedEndpoint, params).catch(() => null);
      if (retry && retry.ok) { response = retry; break; }
    }
  }
  if (!response) {
    if (isTokenPlan) {
      throw new Error(
        `Token Plan 接口不支持浏览器直连（官方未开放跨域），必须走服务端中转；中转调用失败：${proxyError ? proxyError.message : '中转后端未部署或不可达'}。请确认中转后端（test-xinyang.vercel.app）已部署且网络可访问；若仍不行，可在图片服务商里改用「阿里云百炼」（按量）或硅基流动直连生成。`
      );
    }
    throw new Error(`${providerLabel}接口连接失败（网络或跨域被拦截），请刷新后重试，或检查图片接口地址。`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const maskedKey = img.key ? `${img.key.slice(0, 6)}…${img.key.slice(-4)}` : '未填写';
    throw new Error(`${providerLabel}图片接口错误（${response.status}）：${maskSecrets(dashErrorText(text, { provider: img.provider }), [img.key])}（当前使用的图片 Key：${maskedKey}）`);
  }
  const data = await response.json();
  const out = data.output || {};
  let url = out.images?.[0]?.url;
  const contentArr = out.choices?.[0]?.message?.content;
  if (Array.isArray(contentArr)) {
    const part = contentArr.find(p => p && typeof p.image === 'string');
    if (part) url = part.image;
  } else if (typeof contentArr === 'string' && /^(https?:|data:image)/i.test(contentArr)) {
    url = contentArr;
  }
  if (!url) throw new Error(`${providerLabel}图片接口未返回图片`);
  return toSafeDataURL(url);
}

function dashErrorText(raw, { provider } = {}) {
  let text = String(raw || '').trim();
  try {
    const err = JSON.parse(text);
    if (err.code || err.message) text = `${err.code || ''} ${err.message || ''}`.trim();
  } catch {}
  if (!text) text = '未知错误';
  const isTokenPlan = provider === 'qianwen';
  if (/InvalidApiKey|invalid api/i.test(text)) {
    text += isTokenPlan
      ? '（图片 API Key 无效：Token Plan 只认千问AI平台「Token Plan 页面」里的专属 Key（sk-sp- 开头），且接口地址域名必须包含 token-plan（https://token-plan.cn-beijing.maas.aliyuncs.com）；不能用百炼按量 Key（sk-/sk-ws- 开头）、不能用 DeepSeek/硅基文字 Key；复制时不要带空格换行；若订阅已到期也会 401；仍失败请到 Token Plan 页面重置 Key）'
      : '（图片 API Key 无效：如果你在百炼「业务空间」里创建的专属 Key，通用域名不认，必须到 AI 设置→图片接口地址填你的专属域名 {WorkspaceId}.cn-beijing.maas.aliyuncs.com（百炼控制台右上角「业务空间详情」可查 WorkspaceId）后保存重试；另外请确认填的是 sk- 开头 Key（不是 LTAI 开头、不是 DeepSeek/硅基 Key），国内版/国际版域名网站已自动都试过；若仍失败，请到百炼控制台重新生成 Key）';
  } else if (/ModelNotExist|InvalidModel|not found|not supported|未开通|无权限|PermissionDenied|AccessDenied/i.test(text)) {
    text += isTokenPlan
      ? '（请确认模型在 Token Plan 支持列表内且拼写一致：qwen-image-2.0 / qwen-image-2.0-pro / qwen-image-3.0-pro / wan2.7-image / wan2.7-image-pro；403 AccessDenied.Unpurchased 表示该模型不在你的套餐版本内，请改用套餐支持的模型）'
      : '（请确认已在百炼控制台开通/购买 qwen-image-3.0-pro，模型名需完全一致）';
  } else if (/region|地域|WorkspaceId/i.test(text)) {
    text += isTokenPlan
      ? '（Token Plan 只在特定地域提供服务，请确认 Key 与接口地址地域一致，当前默认 https://token-plan.cn-beijing.maas.aliyuncs.com）'
      : '（请确认 API Key 与模型在同一地域；可把业务空间专属域名填到图片接口地址，如 {WorkspaceId}.cn-beijing.maas.aliyuncs.com）';
  } else if (/Throttl|QPS|限流|insufficient_quota|AllocationQuota/i.test(text)) {
    text += '（触发限流或套餐额度不足，请稍后重试；套餐额度用完需等下一个周期或购买加油包）';
  } else if (/size|resolution|参数|InvalidParameter/i.test(text)) {
    text += '（请求参数被接口拒绝，已自动降级重试）';
  }
  return text.slice(0, 300);
}

// 把生成图片 URL 转成本地 dataURL，避免跨域图片污染画布（下载/编辑才不会被浏览器拦截）
async function toSafeDataURL(src) {
  if (/^data:image/i.test(src)) return src;
  try {
    const response = await fetch(src);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    // 图片托管域名不允许跨域读取时，尝试匿名加载后再转 canvas
  }
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => {
        try {
          const temp = document.createElement('canvas');
          temp.width = image.naturalWidth || image.width;
          temp.height = image.naturalHeight || image.height;
          temp.getContext('2d').drawImage(image, 0, 0);
          resolve(temp.toDataURL('image/png'));
        } catch (error) {
          reject(error);
        }
      };
      image.onerror = reject;
      image.src = src;
    });
  } catch (error) {
    return src; // 兜底：直接显示，下载/编辑可能受浏览器跨域限制
  }
}

async function openAILikeImage(prompt, { aspect = 'square', reference = null, size = '' } = {}) {
  const img = getImageConfig();
  if (!img) throw new Error(imageConfigError());
  if (img.provider === 'dashscope' || img.provider === 'qianwen') return dashscopeImage(prompt, { aspect, reference, size });
  if (reference) throw new Error('参考图编辑仅支持阿里云百炼 / 千问AI平台 Token Plan（qwen-image-3.0 / qwen-image-3.0-pro / qwen-image-2.0-pro），请在图片服务商里选择百炼或 Token Plan');
  const base = img.base.replace(/\/+$/, '');
  const model = img.model;
  const isSilicon = img.provider === 'siliconflow';
  const isZhipu = img.provider === 'zhipu';
  const effSize = isSilicon
    ? (aspect === '9:16' ? '768x1360' : aspect === '16:9' ? '1360x768' : '1024x1024')
    : (aspect === '9:16' ? '1024x1536' : aspect === '16:9' ? '1536x1024' : '1024x1024');
  const body = isSilicon
    ? { model, prompt, image_size: effSize, batch_size: 1, response_format: 'b64_json' }
    : isZhipu
      ? { model, prompt, size: effSize }
      : { model, prompt, size: effSize, n: 1, response_format: 'b64_json' };
  const response = await fetch(base + '/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + img.key },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`图片接口错误（${response.status}）：${maskSecrets(String(text).slice(0, 200), [img.key])}`);
  }
  const data = await response.json();
  const item = data.data?.[0];
  if (item?.b64_json) return 'data:image/png;base64,' + item.b64_json;
  if (item?.url) return toSafeDataURL(item.url);
  throw new Error('图片接口未返回图片');
}

function updateAIStatus() {
  const cfg = getAIConfig();
  if (hasByok()) {
    const provider = AI_PROVIDERS[cfg.provider] || AI_PROVIDERS.custom;
    $('aiStatus').textContent = `自填AI：${provider.name}（${cfg.model || provider.model}）`;
  }
}

$('aiSettings').onclick = () => {
  const cfg = getAIConfig();
  $('aiMode').value = cfg.mode || 'vercel';
  $('aiProvider').value = cfg.provider || 'deepseek';
  const provider = AI_PROVIDERS[$('aiProvider').value] || AI_PROVIDERS.deepseek;
  $('aiKey').value = cfg.apiKey || '';
  renderAIModels();
  $('aiModel').value = cfg.model || provider.recommend || provider.model;
  $('aiBaseUrl').value = cfg.baseUrl || '';
  // Token Plan 专属 Key（sk-sp-）自动对应「千问AI平台 Token Plan」选项
  if (/^sk-sp-/i.test(cfg.imageKey || '')) $('aiImageProvider').value = 'qianwen';
  else $('aiImageProvider').value = cfg.imageProvider || '';
  $('aiImageKey').value = cfg.imageKey || '';
  $('aiImageModel').value = cfg.imageModel || '';
  $('aiImageBaseUrl').value = cfg.imageBaseUrl || '';
  // 已开通 qwen-image-3.0-pro：把百炼/Token Plan 的旧默认模型自动升级为 pro
  if ((cfg.imageProvider === 'dashscope' || cfg.imageProvider === 'qianwen') && ['', 'qwen-image', 'qwen-image-3.0'].includes((cfg.imageModel || '').trim())) {
    $('aiImageModel').value = 'qwen-image-3.0-pro';
  }
  applyAIPreset();
  $('aiTestStatus').textContent = '';
  $('aiModal').hidden = false;
  const box = $('aiModal').querySelector('.modal-box');
  if (box) box.scrollTop = 0;
};

function renderAIModels() {
  const provider = AI_PROVIDERS[$('aiProvider').value] || AI_PROVIDERS.custom;
  const models = provider.models?.length ? provider.models : [provider.model || ''];
  $('aiModel').innerHTML = models.map(model => `<option value="${model}">${model}</option>`).join('');
}

function applyAIPreset() {
  const provider = AI_PROVIDERS[$('aiProvider').value] || AI_PROVIDERS.custom;
  if (!$('aiBaseUrl').value) $('aiBaseUrl').value = provider.base;
  $('byokFields').hidden = $('aiMode').value !== 'byok';
  $('imgFields').hidden = $('aiMode').value !== 'byok';
}

$('aiMode').onchange = applyAIPreset;
$('aiProvider').onchange = () => {
  const provider = AI_PROVIDERS[$('aiProvider').value] || AI_PROVIDERS.custom;
  renderAIModels();
  $('aiModel').value = provider.recommend || provider.model;
  $('aiBaseUrl').value = provider.base;
  $('aiImageModel').value = provider.imageModel;
};
$('aiModelSuggest').onclick = () => {
  const provider = AI_PROVIDERS[$('aiProvider').value] || AI_PROVIDERS.custom;
  if (provider.recommend) $('aiModel').value = provider.recommend;
  else alert('该服务商暂无推荐模型，请手动填写。');
};
$('aiImageProvider').onchange = () => {
  const key = $('aiImageProvider').value;
  if (key === 'siliconflow') {
    $('aiImageModel').value = 'black-forest-labs/FLUX.1-schnell';
    $('aiImageBaseUrl').value = 'https://api.siliconflow.cn/v1';
  } else if (key === 'dashscope') {
    $('aiImageModel').value = 'qwen-image-3.0-pro';
    $('aiImageBaseUrl').value = 'https://dashscope.aliyuncs.com';
  } else if (key === 'qianwen') {
    $('aiImageModel').value = 'qwen-image-3.0-pro';
    $('aiImageBaseUrl').value = 'https://token-plan.cn-beijing.maas.aliyuncs.com';
  } else if (key === 'zhipu') {
    $('aiImageModel').value = 'cogview-4-250304';
    $('aiImageBaseUrl').value = 'https://open.bigmodel.cn/api/paas/v4';
  } else if (key === 'openai') {
    $('aiImageModel').value = 'gpt-image-1';
    $('aiImageBaseUrl').value = 'https://api.openai.com/v1';
  } else if (key === 'custom') {
    $('aiImageBaseUrl').value = '';
  }
};
$('aiImageModelSuggest').onclick = () => {
  const key = $('aiImageProvider').value;
  const suggestions = {
    dashscope: 'qwen-image-3.0-pro',
    qianwen: 'qwen-image-3.0-pro',
    siliconflow: 'black-forest-labs/FLUX.1-schnell',
    zhipu: 'cogview-4-250304',
    openai: 'gpt-image-1'
  };
  if (suggestions[key]) {
    $('aiImageModel').value = suggestions[key];
    if (!key.startsWith('custom')) {
      const baseMap = {
        dashscope: 'https://dashscope.aliyuncs.com',
        qianwen: 'https://token-plan.cn-beijing.maas.aliyuncs.com',
        siliconflow: 'https://api.siliconflow.cn/v1',
        zhipu: 'https://open.bigmodel.cn/api/paas/v4',
        openai: 'https://api.openai.com/v1'
      };
      if (!String($('aiImageBaseUrl').value).trim()) $('aiImageBaseUrl').value = baseMap[key] || '';
    }
  } else {
    alert('请先选择图片服务商，再填入推荐模型。');
  }
};
$('aiSave').onclick = () => {
  const cfg = {
    mode: $('aiMode').value,
    provider: $('aiProvider').value,
    apiKey: $('aiKey').value.trim(),
    model: $('aiModel').value.trim(),
    baseUrl: $('aiBaseUrl').value.trim(),
    imageProvider: $('aiImageProvider').value,
    imageKey: $('aiImageKey').value.trim(),
    imageModel: $('aiImageModel').value.trim(),
    imageBaseUrl: $('aiImageBaseUrl').value.trim()
  };
  lsSet(AI_KEY, cfg);
  updateAIStatus();
  $('aiModal').hidden = true;
  if (cfg.mode === 'byok' && !cfg.apiKey) alert('已保存，但 API Key 为空——生成时会自动回退到其他方式。');
  else alert('AI 接入设置已保存。');
};
$('aiClear').onclick = () => {
  localStorage.removeItem(AI_KEY);
  $('aiKey').value = '';
  $('aiModel').value = '';
  $('aiBaseUrl').value = '';
  $('aiImageProvider').value = '';
  $('aiImageKey').value = '';
  $('aiImageModel').value = '';
  $('aiImageBaseUrl').value = '';
  $('aiStatus').textContent = IS_GITHUB_PAGES ? '公网AI：未连接' : '公网AI：未连接';
  alert('已清除自填 Key 设置。');
};
$('kbRefresh').onclick = async () => {
  const btn = $('kbRefresh');
  const old = btn.textContent;
  btn.textContent = '刷新中…';
  btn.disabled = true;
  try {
    const cacheBust = 'v=' + Date.now();
    const resp = await fetch('knowledge_base.json?' + cacheBust);
    if (!resp.ok) throw new Error('knowledge_base.json 不可用');
    const data = await resp.json();
    applyKnowledge(data);
    const live = data?.marketplace?.live || {};
    alert(`知识库已刷新（${live.updated_at || '最近快照'}）：${live.categories?.length || 0} 个品类、${live.flagship_products?.length || 0} 个热销/上新好物、${live.key_coupons?.length || 0} 个重点券已载入。`);
  } catch (e) {
    alert('刷新知识库失败：' + e.message);
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
};
$('aiClose').onclick = () => { $('aiModal').hidden = true; };

// 用户已开通 qwen-image-3.0-pro：页面加载时自动把百炼的旧默认图片模型升级为 pro
(() => {
  const cfg = getAIConfig();
  if ((cfg.imageProvider === 'dashscope' || cfg.imageProvider === 'qianwen') && ['', 'qwen-image', 'qwen-image-3.0'].includes((cfg.imageModel || '').trim())) {
    cfg.imageModel = 'qwen-image-3.0-pro';
    lsSet(AI_KEY, cfg);
  }
})();

$('aiTest').onclick = async () => {
  const cfg = {
    mode: $('aiMode').value,
    provider: $('aiProvider').value,
    apiKey: $('aiKey').value.trim(),
    model: $('aiModel').value.trim(),
    baseUrl: $('aiBaseUrl').value.trim(),
    imageProvider: $('aiImageProvider').value,
    imageKey: $('aiImageKey').value.trim(),
    imageModel: $('aiImageModel').value.trim(),
    imageBaseUrl: $('aiImageBaseUrl').value.trim()
  };
  if (!cfg.apiKey) return alert('先填写 API Key');
  lsSet(AI_KEY, cfg);
  $('aiTestStatus').textContent = '测试中…';
  try {
    const text = await openAILikeChat('你是测试助手', '请只回复四个字：连接成功', { maxTokens: 50 });
    $('aiTestStatus').textContent = `测试成功：${String(text).slice(0, 40)}`;
  } catch (error) {
    $('aiTestStatus').textContent = `测试失败：${error.message}`;
  }
};
$('aiImgTest').onclick = async () => {
  const cfg = {
    mode: $('aiMode').value,
    provider: $('aiProvider').value,
    apiKey: $('aiKey').value.trim(),
    model: $('aiModel').value.trim(),
    baseUrl: $('aiBaseUrl').value.trim(),
    imageProvider: $('aiImageProvider').value,
    imageKey: $('aiImageKey').value.trim(),
    imageModel: $('aiImageModel').value.trim(),
    imageBaseUrl: $('aiImageBaseUrl').value.trim()
  };
  lsSet(AI_KEY, cfg);
  $('aiTestStatus').textContent = '图片测试中…';
  try {
    await openAILikeImage('简单测试贴纸：一只微笑的橘猫，单一主体居中，画面干净，无文字', { aspect: 'square' });
    $('aiTestStatus').textContent = '图片生成测试成功！';
  } catch (error) {
    $('aiTestStatus').textContent = `图片测试失败：${error.message}`;
  }
};
updateAIStatus();

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
  product: { name: '产品类知识库', description: '服务市场上架的酒店主题房与客房产品方案：帮商家讲清上新价值，引导酒店客户到服务市场采购落地。', content_types: ['专业知识','采购指南','优品推荐','优惠福利','内容互动','其他'], topics: ['宠物友好房','亲子房','影音房','舒睡房'] },
  platform: { name: '平台类知识库', description: '服务市场平台本身：入口与账号、下单流程、售后申请，让酒店客户会用、敢买。', content_types: ['功能科普','操作指南','问题解答','平台好物','旅拍合作','内容互动'], topics: ['下单流程','订单查询','售后申请','酒店用品推荐','旅拍合作'] },
  payment: { name: '支付类知识库', description: '服务市场内的支付与结算：对公支付、账单分期、免房置换、退款发票，帮助酒店客户顺利成交。', content_types: ['支付科普','付款指南','退款指南','免房置换','账单分期','风险提示'], topics: ['现金支付','对公转账','退款路径','免房置换','账单分期'] },
  campaign: { name: '活动类知识库', description: '服务市场平台活动（双11、618、酒店采购节等）：借活动节点推动酒店客户在服务市场下单。', content_types: ['优惠福利','活动预热','倒计时','爆品推荐','限时促单','活动复盘'], topics: ['双11','618','酒店采购节','开业季','暑期亲子季'] },
  insight: { name: '干货类知识库', description: '酒店运营干货与行业洞察：用专业内容建立信任，最终把酒店客户引导到服务市场获取解决方案。', content_types: ['专业知识','运营清单','案例拆解','避坑指南','数据洞察','内容互动'], topics: ['酒店好评差评','酒店采购清单','前台常见问题','OTA运营','投诉处理'] }
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
      <b>${escapeHtml(value.name)}</b>
      <p>${escapeHtml(value.description || '持续沉淀酒店行业可复用内容。')}</p>
      <ul>${topics.slice(0, 5).map(topic => `<li>${escapeHtml(topic)}</li>`).join('')}</ul>
    </article>`;
  }).join('');
  observeReveal();
}

renderSelectors();
$('category').addEventListener('change', renderContentTypes);

function applyKnowledge(data) {
  if (!data?.categories) return false;
  const selected = $('category').value;
  knowledge = data;
  window.__tripMallKB = {
    loaded: !!data.marketplace?.catalog,
    cats: Object.keys(data.categories).length,
    live: data.marketplace?.live || null
  };
  renderSelectors();
  if (knowledge.categories[selected]) $('category').value = selected;
  renderContentTypes();
  return true;
}

function loadKnowledge() {
  const cacheBust = 'v=' + Date.now();
  return fetch('knowledge_base.json?' + cacheBust).then(response => {
    if (!response.ok) throw new Error('local kb unavailable');
    return response.json();
  }).then(applyKnowledge).catch(() => {
    return fetch(apiUrl('/api/knowledge')).then(response => {
      if (!response.ok) throw new Error('knowledge unavailable');
      return response.json();
    }).then(applyKnowledge).catch(() => {});
  });
}

loadKnowledge();

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
  copyHistory: 'tripMall.history.copy',
  posterHistory: 'tripMall.history.poster'
};

function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

let materials = lsGet(LS.materials, []);
let drafts = lsGet(LS.drafts, []);
let posterMemory = lsGet(LS.posterMemory, []);
let copyHistory = lsGet(LS.copyHistory, []);
let posterHistory = lsGet(LS.posterHistory, []);

function renderLearnList() {
  if ($('learnCount')) $('learnCount').textContent = `已学习 ${materials.length} 份素材`;
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
      if (item) { item.checked = input.checked; lsSet(LS.materials, materials); profileDirty = true; }
    };
  });
  $('learnList').querySelectorAll('.x').forEach(button => {
    button.onclick = () => {
      materials = materials.filter(m => String(m.id) !== button.dataset.del);
      lsSet(LS.materials, materials);
      profileDirty = true;
      renderLearnList();
    };
  });
}

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

/* ============================ 生成进度条 ============================ */

function startProgress(barId) {
  const bar = $(barId);
  const pct = $(barId + 'Pct');
  const fill = $(barId + 'Fill');
  const noop = { done() {}, fail() {}, stop() {} };
  if (!bar || !pct || !fill) return noop;
  bar.hidden = false;
  bar.classList.remove('done', 'fail');
  pct.textContent = '1%';
  fill.style.width = '1%';
  let progress = 1;
  let timer = null;
  let finished = false;
  const tick = () => {
    if (finished) return;
    // 先快后慢：0-55% 快速推进，55-85% 放缓，85-95% 很慢，95% 后蜗牛爬，完成时直接拉满
    let step;
    if (progress < 55) step = 0.9 + Math.random() * 1.5;
    else if (progress < 85) step = 0.35 + Math.random() * 0.55;
    else if (progress < 95) step = 0.12 + Math.random() * 0.18;
    else step = 0.04;
    progress = Math.min(99.5, progress + step);
    pct.textContent = Math.floor(progress) + '%';
    fill.style.width = Math.floor(progress) + '%';
    timer = setTimeout(tick, 170);
  };
  timer = setTimeout(tick, 170);
  return {
    done() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      pct.textContent = '100%';
      fill.style.width = '100%';
      bar.classList.add('done');
      setTimeout(() => { bar.hidden = true; }, 1000);
    },
    fail() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      bar.classList.add('fail');
      setTimeout(() => { bar.hidden = true; }, 1600);
    },
    stop() {
      finished = true;
      clearTimeout(timer);
      bar.hidden = true;
    }
  };
}

/* ============================ 生成历史记录 ============================ */

function saveCopyHistory(record) {
  copyHistory.unshift({
    id: Date.now(),
    time: Date.now(),
    category: '',
    product: '',
    persona: '',
    channel: '',
    content_type: '',
    needs: '',
    content: '',
    ...record
  });
  if (copyHistory.length > 100) copyHistory = copyHistory.slice(0, 100);
  while (copyHistory.length && !lsSet(LS.copyHistory, copyHistory)) copyHistory.pop();
}

function savePosterHistory(record) {
  posterHistory.unshift({
    id: Date.now(),
    time: Date.now(),
    type: 'ai-poster',
    instruction: '',
    prompt: '',
    style: '',
    engine: '',
    width: 1080,
    height: 1920,
    image: '',
    ...record
  });
  if (posterHistory.length > 12) posterHistory = posterHistory.slice(0, 12);
  // localStorage 空间不够时自动淘汰最旧记录，保证历史可用
  while (posterHistory.length && !lsSet(LS.posterHistory, posterHistory)) posterHistory.pop();
}

async function posterHistoryImage(src, maxSide = 1440, quality = 0.85) {
  try {
    if (!/^data:image/i.test(src)) return src;
    const image = new Image();
    image.src = src;
    await image.decode();
    const w0 = image.naturalWidth || image.width;
    const h0 = image.naturalHeight || image.height;
    const scale = Math.min(1, maxSide / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const temp = document.createElement('canvas');
    temp.width = w;
    temp.height = h;
    temp.getContext('2d').drawImage(image, 0, 0, w, h);
    return temp.toDataURL('image/jpeg', quality);
  } catch {
    return src;
  }
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

function openHistory(kind) {
  const modal = $('historyModal');
  const title = $('historyTitle');
  const hint = $('historyHint');
  const list = $('historyList');
  if (kind === 'copy') {
    title.textContent = '文案历史记录';
    hint.textContent = '按时间倒序展示最近 100 条生成记录，可编辑、复制或删除。';
    renderCopyHistory(list);
  } else {
    title.textContent = '海报历史记录';
    hint.textContent = '按时间倒序展示最近 15 条生成记录，可继续编辑、修改说明或删除。';
    renderPosterHistory(list);
  }
  modal.hidden = false;
  const box = modal.querySelector('.modal-box');
  if (box) box.scrollTop = 0;
}

function renderCopyHistory(list) {
  if (!copyHistory.length) {
    list.innerHTML = '<p class="history-empty">还没有文案生成记录，先生成一条吧。</p>';
    return;
  }
  list.innerHTML = [...copyHistory]
    .sort((a, b) => b.time - a.time)
    .map(item => `
      <div class="history-item" data-id="${item.id}">
        <div class="history-head">
          <span class="history-time">${fmtTime(item.time)}</span>
          <span class="history-badges">
            ${item.channel ? `<span class="badge">${escapeHtml(item.channel)}</span>` : ''}
            ${item.product ? `<span class="badge">${escapeHtml(item.product)}</span>` : ''}
          </span>
          <span class="history-actions">
            <button type="button" data-copy="${item.id}">复制</button>
            <button type="button" data-edit="${item.id}">编辑</button>
            <button type="button" class="danger" data-del="${item.id}">删除</button>
          </span>
        </div>
        <div class="history-body">${escapeHtml(item.content)}</div>
        <textarea class="history-edit" rows="8"></textarea>
      </div>`).join('');
  list.querySelectorAll('.history-item').forEach(row => {
    const id = Number(row.dataset.id);
    const record = copyHistory.find(item => item.id === id);
    const body = row.querySelector('.history-body');
    const editor = row.querySelector('.history-edit');
    if (record) editor.value = record.content;
    row.querySelector('[data-copy]').onclick = async () => {
      try {
        await navigator.clipboard.writeText(record.content);
        alert('已复制到剪贴板');
      } catch {
        const ta = document.createElement('textarea');
        ta.value = record.content;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        alert('已复制到剪贴板');
      }
    };
    row.querySelector('[data-edit]').onclick = () => {
      row.classList.toggle('editing');
      editor.focus();
    };
    row.querySelector('[data-del]').onclick = () => {
      if (!confirm('确定删除这条历史记录吗？')) return;
      copyHistory = copyHistory.filter(item => item.id !== id);
      lsSet(LS.copyHistory, copyHistory);
      row.remove();
      if (!copyHistory.length) renderCopyHistory(list);
    };
    editor.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        record.content = editor.value;
        body.textContent = record.content;
        row.classList.remove('editing');
        lsSet(LS.copyHistory, copyHistory);
      }
    });
    editor.addEventListener('blur', () => {
      if (editor.value !== record.content) {
        record.content = editor.value;
        body.textContent = record.content;
        lsSet(LS.copyHistory, copyHistory);
      }
      row.classList.remove('editing');
    });
  });
}

function renderPosterHistory(list) {
  if (!posterHistory.length) {
    list.innerHTML = '<p class="history-empty">还没有海报生成记录，先生成一张吧。</p>';
    return;
  }
  list.innerHTML = [...posterHistory]
    .sort((a, b) => b.time - a.time)
    .map(item => `
      <div class="history-item" data-id="${item.id}">
        <div class="history-head">
          <span class="history-time">${fmtTime(item.time)}</span>
          <span class="history-badges">
            <span class="badge">${item.type === 'ai-edit' ? 'AI 编辑' : '成品海报'}</span>
            ${item.style ? `<span class="badge">${escapeHtml(item.style)}</span>` : ''}
          </span>
          <span class="history-actions">
            <button type="button" data-load="${item.id}">继续编辑</button>
            <button type="button" data-edit="${item.id}">修改说明</button>
            <button type="button" class="danger" data-del="${item.id}">删除</button>
          </span>
        </div>
        <div class="history-poster">
          <img src="${item.image}" alt="海报预览">
          <div class="history-meta">
            <div><b>指令：</b><span class="clip">${escapeHtml(item.instruction)}</span></div>
            <div><b>引擎：</b>${escapeHtml(item.engine || '—')}</div>
            <div><b>尺寸：</b>${item.width}×${item.height}</div>
          </div>
        </div>
        <textarea class="history-edit" rows="4"></textarea>
      </div>`).join('');
  list.querySelectorAll('.history-item').forEach(row => {
    const id = Number(row.dataset.id);
    const record = posterHistory.find(item => item.id === id);
    const editor = row.querySelector('.history-edit');
    const meta = row.querySelector('.history-meta .clip');
    if (record) editor.value = record.instruction;
    row.querySelector('[data-load]').onclick = () => {
      loadPosterRecord(record);
      $('historyModal').hidden = true;
    };
    row.querySelector('[data-edit]').onclick = () => {
      row.classList.toggle('editing');
      editor.focus();
    };
    row.querySelector('[data-del]').onclick = () => {
      if (!confirm('确定删除这条海报历史记录吗？')) return;
      posterHistory = posterHistory.filter(item => item.id !== id);
      lsSet(LS.posterHistory, posterHistory);
      row.remove();
      if (!posterHistory.length) renderPosterHistory(list);
    };
    editor.addEventListener('blur', () => {
      if (record && editor.value !== record.instruction) {
        record.instruction = editor.value;
        if (meta) meta.textContent = editor.value;
        lsSet(LS.posterHistory, posterHistory);
      }
      row.classList.remove('editing');
    });
  });
}

function loadPosterRecord(record) {
  const image = new Image();
  image.onload = () => {
    snapshot();
    backgroundImage = image;
    backgroundInfo = { mode: 'history', style: record.style || '历史记录' };
    objects = objects.filter(object => object.type !== 'text');
    selected = null;
    draw();
    renderLayers();
    const nav = $('posterNav');
    if (nav) {
      nav.querySelectorAll('button[data-view]').forEach(b => b.classList.remove('on'));
      const gen = nav.querySelector('[data-view="gen"]');
      if (gen) gen.classList.add('on');
    }
    document.querySelectorAll('.view').forEach(view => {
      view.hidden = view.dataset.view !== 'gen';
    });
    $('aiPosterStatus').textContent = '已从历史记录载入海报，可继续编辑、添加文案或下载。';
  };
  image.onerror = () => alert('海报图片载入失败，可能已损坏。');
  image.src = record.image;
}

$('copyHistoryBtn').onclick = () => openHistory('copy');
$('posterHistoryBtn').onclick = () => openHistory('poster');
$('historyClose').onclick = () => { $('historyModal').hidden = true; };
$('historyModal').addEventListener('click', event => {
  if (event.target === $('historyModal')) $('historyModal').hidden = true;
});

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
  profileDirty = true;
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

let profileDirty = true;

function profileSource() {
  const source = checkedMaterialsText();
  return source
    ? source + '\n\n【手动粘贴样本】\n' + $('samples').value.slice(0, 8000)
    : $('samples').value.slice(0, 12000);
}

async function ensureProfile() {
  if (!profileDirty) return;
  const fullSource = profileSource();
  if (!fullSource.trim()) return;
  const prompt = `你是资深中文文案编辑。从以下素材中提炼一份“风格画像”，让之后只凭简短提示词就能生成同风格内容。
素材：
${fullSource.slice(0, 20000)}
请输出中文风格画像，包含：1)整体语气；2)高频句式与开头方式；3)结构习惯；4)常用词与口头禅；5)内容长度与信息密度；6)最忌讳的写法（避免的AI腔）。400字以内，直接输出画像正文，不要Markdown标题。`;
  try {
    let profile;
    if (hasByok()) {
      profile = await openAILikeChat('你是资深中文文案编辑。', prompt, { maxTokens: 1200, temperature: 0.6 });
    } else {
      try {
        if (IS_GITHUB_PAGES) throw new Error('use puter');
        profile = (await apiRequest('/api/profile', { source: fullSource }, 30000)).content;
      } catch (apiError) {
        if (IS_GITHUB_PAGES) await ensurePuterAuth();
        profile = await puterChat(prompt);
      }
    }
    $('profileBox').value = profile.trim();
    lsSet(LS.profile, profile.trim());
    profileDirty = false;
  } catch {}
}

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
  profileDirty = true;
  renderLearnList();
  renderPosterMemory();
  renderDraftCount();
  alert('已清空学习素材与画像。');
};

$('profileBox').value = lsGet(LS.profile, '');
$('profileBox').oninput = () => { lsSet(LS.profile, $('profileBox').value); profileDirty = false; };
$('samples').oninput = () => { profileDirty = true; };
renderLearnList();

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
    let content;
    if (hasByok()) {
      content = await openAILikeChat(
        '你是携程酒店服务市场的研究助手（当前为自填AI，无联网能力，仅凭已有知识输出，不确定处明确注明）。',
        `请围绕酒店行业主题“${payload.product}”（服务于${payload.category_name}内容创作）输出：可验证事实、目标人群、竞品做法、社媒高互动选题、采购或运营问题、风险与数据口径。不要编造具体数据，不确定的信息要明确说明。`,
        { maxTokens: 3000 }
      );
      content = '【自填AI·无联网】\n' + content;
    } else {
      if (IS_GITHUB_PAGES) await ensurePuterAuth();
      try {
        if (IS_GITHUB_PAGES) throw new Error('使用公共AI');
        content = (await apiRequest('/api/research', payload, 20000)).content;
      } catch (apiError) {
        content = await puterChat(
          `请联网研究酒店行业主题“${payload.product}”，服务于${payload.category_name}内容创作。重点查找最新公开趋势、目标人群、竞品做法、社媒高互动选题、采购或运营问题。输出：可验证事实、来源、竞品启发、可执行选题、风险与数据口径。不要复制原文，不确定的信息要明确说明。`,
          { tools: [{ type: 'web_search' }] }
        );
      }
    }
    research = content;
    $('samples').value = `【联网研究】\n${research}\n\n${$('samples').value}`;
    profileDirty = true;
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
  '朋友圈': '朋友圈：输出3条，每条150-250字左右，像真人发的圈，有小故事感、场景感，不硬广。',
  '小红书': '小红书：完整种草或知识型成稿，含标题、正文、话题标签，真实体验感。',
  '公众号': '公众号：输出具体标题、导语、详细正文和CTA。',
  '销售话术': '销售话术：按真实沟通场景输出，含开场、需求挖掘、异议处理、促成动作。',
  '短视频口播': '短视频口播：脚本化，含钩子开场、节奏点、结尾引导，标注画面建议。',
  '内部提案': '内部提案：结构完整，含背景、方案、预算参考、风险与下一步。'
};

const CHANNEL_FORMATS = {
  '朋友圈': '输出3条朋友圈文案：每条以「朋友圈①」「朋友圈②」「朋友圈③」开头，每条150-250字，分2-3个短段落，有具体场景和小故事感，结尾一句自然引导，不硬广。只输出这3条文案本身，不要输出任何其他分析或说明。',
  '社群运营': '输出1条社群运营文案：150-200字，像真实运营者在群里自然说话，有活人感、允许口语化和语气词，结尾自然引导互动。只输出这条文案本身。',
  '小红书': '输出1篇完整小红书笔记：标题（带emoji、15字左右）+正文（600-1000字，真实体验感、分小节）+结尾5个话题标签。只输出笔记本身。',
  '公众号': '输出1篇公众号文章：10-20字标题、80字内导语、1200-2000字正文（分小节）、结尾CTA。',
  '销售话术': '输出销售话术：按「开场→需求挖掘→异议处理→促成」的顺序，写成能直接对客户说出口的话，标注每一段的话术目的。',
  '短视频口播': '输出短视频口播脚本：开头钩子（3秒内）+正文3-5个节奏点+结尾引导，每句标注画面建议。',
  '内部提案': '输出内部提案：背景→方案→预算参考→风险→下一步，结构完整、可直接汇报。'
};

const KNOWLEDGE_STANCE = `平台立场（最高优先级，必须严格遵守）：你是携程酒店服务市场（Hmall）的内容运营。
服务市场是酒店B2B一站式采购与服务平台：服务商/供应商把酒店经营所需的产品与服务
（主题房方案、酒店用品、布草、设施、设计、旅拍、运营服务等）上架到服务市场，
酒店客户在平台上浏览、比价、下单、支付与售后，采购成本可降低10%-30%。
『上新』指产品/服务在服务市场上架，而不是酒店房型上新。
所有内容必须站在服务市场/商家面向酒店客户的角度：讲清楚产品为酒店创造什么价值、
为什么在服务市场采购更省心（放心、低价、一站式、售后支持）、如何登录服务市场了解或下单。
不要把内容写成酒店经营者对住客的自我宣传（除非用户明确选择『酒店视角』）；
涉及平台规则与官方表述，以携程酒店商家管理后台官网（ebooking.ctrip.com/hmall/index）
及服务市场官方页面为准，不要凭空编造；联网搜索结果仅作事实与趋势参考，不要照搬其表述视角。`;

const PRODUCT_BRIEF = `服务市场产品与优势速览（写内容时可引用）：平台精选客房用品、酒店布草、酒店设施、
视觉设计、特色服务五大品类、上千个SKU；主题房改造（亲子房、宠物友好房、影音房、舒睡房等）
是设计+物资配置+运营营销的一站式方案；官方六大服务保障：免房置换、低价保证、送货到店、
快速开票、先行赔付、7天无理由退货；供应商-平台-酒店三步直达，集采成本可降低10%-30%（参考值）。`;

function knowledgeContext(payload) {
  const cat = knowledge.categories?.[payload.category] || {};
  const mp = knowledge.marketplace || {};
  const catName = cat.name || payload.category || '';
  const topics = Array.isArray(cat.topics) ? cat.topics.join('、')
    : (cat.topics ? Object.keys(cat.topics).join('、') : '');
  const catalog = Array.isArray(mp.catalog?.categories)
    ? mp.catalog.categories.map(c => `· ${c.name}：${c.desc}（${(c.examples || []).join('；')}）`).join('\n')
    : '';
  const advantages = Array.isArray(mp.advantages?.platform_advantages)
    ? mp.advantages.platform_advantages.map(a => `· ${a}`).join('\n')
    : '';
  const guarantees = mp.advantages?.official_guarantees || '';
  const live = mp.live || {};
  const liveCats = Array.isArray(live.categories) ? live.categories : [];
  const wantsCompare = /对比|比较|分析|竞品|哪个好|哪家好|品牌推荐|选型|区别|差异|怎么选/.test(String(payload.needs || '') + String(payload.product || '') + String(payload.content_type || ''));
  const matchedCats = liveCats.filter(c => wantsCompare || !payload.category || c.name === payload.category || c.parent === payload.category);
  const liveCatBlock = matchedCats.length
    ? matchedCats.slice(0, wantsCompare ? 10 : 6).map(c =>
        `· ${c.parent} / ${c.name}（cat=${c.cat}）\n` +
        `  三级分类：${(c.sub_categories || []).join('、') || '—'}\n` +
        `  代表品牌：${(c.brands || []).join('、') || '—'}` +
        (wantsCompare && c.brands?.length ? `（服务市场在售，可按需对比）` : '') + '\n' +
        `  在售代表商品：${(c.sample_products || []).join('；') || '—'}`
      ).join('\n')
    : '';
  const wantsRecommendation = /推荐|好物|精选|清单|爆款/.test(String(payload.needs || '') + String(payload.content_type || ''));
  const kw = String(payload.needs || '') + String(payload.product || '');
  const isBroadCat = !payload.category || ['product', 'platform', 'campaign', 'insight', 'payment'].includes(payload.category);
  const kwScore = p => {
    let s = 0;
    const hit = t => (p.name || '').includes(t) || (p.cat || '').includes(t) || (p.note || '').includes(t);
    ['宠物','布草','亲子','影音','舒睡','智能','机器人','耗品','牙具','毛巾','床垫','吹风机','摄影','旅拍','电玩','电竞','咖啡','食材'].forEach(t => { if (kw.includes(t) && hit(t)) s += 3; });
    return s;
  };
  const flagshipBlock = Array.isArray(live.flagship_products)
    ? live.flagship_products
        .filter(p => wantsRecommendation || wantsCompare || isBroadCat || !p.cat || p.cat === payload.category || p.cat.includes(payload.category))
        .sort((a, b) => kwScore(b) - kwScore(a))
        .slice(0, (wantsRecommendation || wantsCompare) ? 24 : 12)
        .map(p => `· ${p.name}｜${p.cat || ''}｜${p.price}｜${p.sales || ''}${p.rating ? '｜' + p.rating : ''}${p.coupon ? '｜' + p.coupon : ''}${p.note ? '｜' + p.note : ''}`)
        .join('\n')
    : '';
  const couponBlock = Array.isArray(live.key_coupons)
    ? live.key_coupons.map(c => `· ¥${c.amount} ${c.threshold}｜${c.scope}${c.note ? '｜' + c.note : ''}`).join('\n')
    : '';
  const stats = live.platform_stats || {};
  const sections = [];
  if (mp.what_is) sections.push(`【服务市场是什么】${mp.what_is}`);
  sections.push(`【服务市场产品体系】\n${catalog || PRODUCT_BRIEF}`);
  if (guarantees) sections.push(`【官方六大服务保障】${guarantees}`);
  if (advantages) sections.push(`【平台优势】\n${advantages}`);
  if (liveCats.length) {
    sections.push(`【服务市场实时商品库（${live.updated_at || '最近抓取'}快照）】
平台大盘：${stats.suppliers || '—'}家供应商｜年销量${stats.annual_sales_orders || '—'}单｜在售商品${stats.sku_count || '—'}种
${liveCatBlock || '（当前分类暂无明细，可参考其他分类）'}`);
  }
  if (flagshipBlock) sections.push(`【服务市场热销/上新好物参考】\n${flagshipBlock}`);
  if (couponBlock) sections.push(`【服务市场当前活动券参考】\n${couponBlock}`);
  if (live.update_note) sections.push(`【数据时效说明】${live.update_note}`);
  sections.push(`【当前知识库分类】${catName}：${cat.description || ''}${topics ? '（可参考主题：' + topics + '）' : ''}`);
  if (mp.official_site) sections.push(`【官方来源】${mp.official_site}——涉及平台规则以官方页面为准`);
  return sections.join('\n\n');
}

function buildSystemPrompt(payload) {
  return `你是携程酒店服务市场（Hmall）的资深内容运营，为酒店写真实、生动、可直接发布的中文内容。\n\n${KNOWLEDGE_STANCE}\n\n${knowledgeContext(payload)}`;
}

function buildTaskPrompt(payload) {
  const wantsCompare = /对比|比较|分析|竞品|哪个好|哪家好|品牌推荐|选型|区别|差异|怎么选/.test(String(payload.needs || '') + String(payload.product || '') + String(payload.content_type || ''));
  return `请为以下任务输出内容：
产品/主题：${payload.product}
目标视角：${payload.persona}
发布渠道/文章类型：${payload.channel}
内容类型：${payload.content_type}
生成需求（个性化要求，务必逐一满足）：${payload.needs || '无'}
联网研究：${payload.research || '无'}
文章风格样本：${String(payload.style_samples || '').slice(0, 12000)}
风格画像（AI学习总结，生成时严格遵循其语气、句式与结构习惯）：${String(payload.profile || '').slice(0, 6000)}
用户学习素材摘要（提炼要点融入，不要照抄原文）：${String(payload.materials || '').slice(0, 8000)}

【输出格式（必须严格遵守，逐字执行）】
${CHANNEL_FORMATS[payload.channel] || '按其使用场景输出完整成稿。'}

【硬性要求】
1. 直接输出正文，禁止以“好的”“以下是为您准备的”“根据您的需求”等开头。
2. 禁止复述或总结用户需求；禁止空话、套话、车轱辘话凑字数——字数宁短勿水，严格卡在格式要求范围内。
3. 站在服务市场/商家面向酒店客户的角度展开（除非用户明确要求酒店视角）。
4. 若用户给出已有文案或细节要求（调整细节、强调IP、强调功能、强调价格），先理解原意再改写，不丢失关键信息。
5. 内部数字写成参考值，不编造平台规则；避免“值得注意的是”“综上所述”“在这个…的时代”等AI腔。
${wantsCompare ? `6. 本任务需要品牌对比/分析：必须从【服务市场实时商品库】与【热销/上新好物参考】中引用真实在售品牌与商品名（如红杉树、尊客、恒创、悦诗兰庭、洁柔、小帅、奶龙、B.Duck、梦百合等），逐品牌说明定位、代表商品、价格区间、销量/好评与适用酒店场景；禁止用“某品牌”“部分品牌”“一些品牌”等含糊表述代替具体品牌名。若知识库中某品类缺少品牌数据，如实说明“该品类暂无明确品牌数据”，不得编造。` : ''}
7. 涉及具体价格、销量、优惠券时，标注“参考价/参考销量”，并提示以服务市场页面为准。`;
}

function buildGeneratePrompt(payload) {
  return buildSystemPrompt(payload) + '\n\n' + buildTaskPrompt(payload);
}

$('generate').onclick = async event => {
  const button = event.currentTarget;
  const progress = startProgress('copyProgress');
  button.textContent = 'AI学习中…';
  await ensureProfile();
  button.textContent = 'AI生成中…';
  const payload = {
    category: $('category').value,
    product: $('product').value,
    persona: $('persona').value,
    channel: $('channel').value,
    content_type: $('contentType').value,
    needs: $('needs').value,
    research,
    style_samples: $('samples').value,
    profile: $('profileBox').value,
    materials: checkedMaterialsText()
  };
  try {
    let content;
    if (hasByok()) {
      content = await openAILikeChat(
        buildSystemPrompt(payload),
        buildTaskPrompt(payload),
        { maxTokens: 6500 }
      );
    } else {
      if (IS_GITHUB_PAGES) await ensurePuterAuth();
      try {
        if (IS_GITHUB_PAGES) throw new Error('使用公共AI');
        content = (await apiRequest('/api/generate', payload, 30000)).content;
      } catch (apiError) {
        content = await puterChat(buildGeneratePrompt(payload));
      }
    }
    $('result').textContent = content;
    saveCopyHistory({
      category: payload.category,
      product: payload.product,
      persona: payload.persona,
      channel: payload.channel,
      content_type: payload.content_type,
      needs: payload.needs,
      content
    });
    progress.done();
  } catch (error) {
    $('result').textContent = `AI生成失败：${error.message}\n\n提示：Puter 免费额度可能已用完或需要登录。请点击上方「AI 设置」，填入 DeepSeek / 硅基流动 / 智谱 的免费 API Key（国内可直连），保存后即可恢复生成。`;
    progress.fail();
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

function draw() {
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
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
  const sizeVal = selected.type === 'text'
    ? Math.min(180, selected.size)
    : Math.min(180, selected.scale * 100);
  const sizeEl = $('size');
  if (sizeEl && sizeEl.value !== undefined) sizeEl.value = sizeVal;
  const rotateEl = $('rotate');
  if (rotateEl && rotateEl.value !== undefined) rotateEl.value = selected.rotation;
  if (selected.color) $('color').value = selected.color;
  if (selected.font) $('font').value = selected.font;
}

function smartTextColor() {
  try {
    const src = backgroundImage || (objects.find(o => o.type === 'image') || {}).src;
    if (!src) return '#29231e';
    const temp = document.createElement('canvas');
    temp.width = 24;
    temp.height = 24;
    const g = temp.getContext('2d');
    g.drawImage(src, 0, 0, 24, 24);
    const d = g.getImageData(0, 0, 24, 24).data;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      n++;
    }
    const avg = sum / n;
    return avg > 150 ? '#29231e' : '#ffffff';
  } catch {
    return '#29231e';
  }
}

function addText(text, x, y, size = 72, color = smartTextColor(), font = 'Microsoft YaHei', weight = 700) {
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
    backgroundInfo: backgroundInfo ? { ...backgroundInfo } : null,
    canvasW: canvas.width,
    canvasH: canvas.height
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
  canvas.width = state.canvasW || 1080;
  canvas.height = state.canvasH || 1920;
  objects = state.objects.map(object => ({ ...object }));
  backgroundImage = state.backgroundImage;
  backgroundInfo = state.backgroundInfo ? { ...state.backgroundInfo } : null;
  selected = null;
  $('posterWidth').value = canvas.width;
  $('posterHeight').value = canvas.height;
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
  const sx = canvas.width / 1080;
  const sy = canvas.height / 1920;
  const s = Math.min(sx, sy);
  const cx = canvas.width / 2;
  addTextNoSnapshot(copy.eyebrow, cx, 130 * sy, 34 * s, colors.ink, 'Microsoft YaHei', 700);
  addTextNoSnapshot(copy.headline, cx, 310 * sy, 118 * s, colors.ink, 'SimHei', 900);
  addTextNoSnapshot(copy.subheadline, cx, 430 * sy, 40 * s, colors.sub, 'Microsoft YaHei', 700);
  addTextNoSnapshot(copy.price, cx, 570 * sy, 52 * s, colors.accent, 'Microsoft YaHei', 900);
  copy.features.forEach((text, index) => addTextNoSnapshot(text, (225 + index * 315) * sx, 1340 * sy, 38 * s, colors.sub, 'Microsoft YaHei', 800));
  copy.metrics.forEach((item, index) => {
    addTextNoSnapshot(item.value, (225 + index * 315) * sx, 1545 * sy, 58 * s, colors.accent, 'Microsoft YaHei', 900);
    addTextNoSnapshot(item.label, (225 + index * 315) * sx, 1610 * sy, 28 * s, colors.sub, 'Microsoft YaHei', 600);
  });
  addTextNoSnapshot(copy.cta, cx, 1810 * sy, 38 * s, '#ffffff', 'Microsoft YaHei', 800);
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
    let copy;
    const prompt = `为Trip MALL携程酒店服务市场生成一套竖版营销海报短文案。产品：${payload.product}；知识库：${payload.category_name}；营销目标：${payload.goal}；目标视角：${payload.persona}。只返回JSON：{"eyebrow":"12字以内","headline":"14字以内","subheadline":"24字以内","price":"16字以内核心利益","features":["8字以内","8字以内","8字以内"],"metrics":[{"value":"短词或数字","label":"8字以内"},{"value":"短词或数字","label":"8字以内"},{"value":"短词或数字","label":"8字以内"}],"cta":"12字以内"}。没有可靠数字时用省心、专业、快速等利益点，不编造数据。`;
    if (hasByok()) {
      copy = extractJson(await openAILikeChat('你是Trip MALL海报文案专家，只输出严格JSON。', prompt, { maxTokens: 1000 }));
    } else {
      try {
        if (IS_GITHUB_PAGES) throw new Error('使用公共AI');
        copy = await apiRequest('/api/poster-copy', payload, 20000);
      } catch (apiError) {
        copy = extractJson(await puterChat(prompt));
      }
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
    elements: $('bgElements').value
  };
  button.textContent = '生成底图中…';
  $('bgEngineStatus').textContent = '';
  const sceneText = payload.scene ? `场景：${payload.scene}。` : '';
  const desc = payload.description
    ? `画面主体必须精确为：${payload.description}。`
    : '';
  const paletteText = /香槟|金色|轻奢|咖啡|深咖/.test(String(payload.style || ''))
    ? 'Premium champagne gold / warm ivory / dark coffee palette.'
    : 'Color palette naturally matched to the theme and scene, rich and varied, avoid a single monotonous brand tone.';
  const styleLine = payload.style ? `，整体风格：${payload.style}` : '';
  const qualityPrompt = `请为「${payload.product}」生成一张 9:16 竖版酒店营销海报底图${styleLine}。
${sceneText}${desc}
${payload.elements ? `可搭配的视觉元素：${payload.elements}。` : ''}
画面要求：主体与主题紧密相关、构图大气有层次，上方和中部预留干净空白用于排版标题与文案；配色根据主题自然搭配、丰富有质感${paletteText.includes('champagne') ? '（香槟金、暖白、深咖）' : ''}；光线自然、有明暗对比、商业广告质感。
底图内不要出现任何文字、水印、Logo、人脸或畸形形象。`;
  try {
    let image;
    if (hasByokImage()) {
      const src = await openAILikeImage(qualityPrompt, { aspect: '9:16' });
      image = new Image();
      image.src = src;
      await image.decode();
      $('bgEngineStatus').textContent = `引擎：自填AI图片（${getImageConfig().model}）`;
    } else {
      if (IS_GITHUB_PAGES) await ensurePuterAuth();
      try {
        if (IS_GITHUB_PAGES) throw new Error('使用公共AI');
        const data = await apiRequest('/api/poster', payload, 30000);
        image = new Image();
        image.src = data.image;
        await image.decode();
        $('bgEngineStatus').textContent = '引擎：OpenAI gpt-image-2（Vercel API）';
      } catch (apiError) {
        if (!window.puter?.ai?.txt2img) throw new Error('Puter图片服务未加载');
        const puterModel = await pickPuterImageModel();
        image = await window.puter.ai.txt2img(qualityPrompt, { model: puterModel, ratio: '9:16' });
        $('bgEngineStatus').textContent = `引擎：Puter 公共AI（${puterModel}）— 后端API不可用时自动降级`;
      }
    }
    snapshot();
    backgroundImage = image;
    backgroundInfo = { mode: 'ai', style: payload.style, scene: payload.scene, description: payload.description };
    draw();
  } catch (error) {
    alert(`底图生成失败：${error.message}`);
    $('bgEngineStatus').textContent = '';
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

/* 海报功能导航：点击导航块切换对应功能页 */
const posterNav = $('posterNav');
if (posterNav) {
  posterNav.querySelectorAll('button[data-view]').forEach(button => {
    button.onclick = () => {
      posterNav.querySelectorAll('button[data-view]').forEach(b => b.classList.remove('on'));
      button.classList.add('on');
      document.querySelectorAll('.view').forEach(view => {
        view.hidden = view.dataset.view !== button.dataset.view;
      });
    };
  });
}

/* AI 成品海报：指令 + 参考图 → 一键生成成品海报 */
$('aiPosterBtn').onclick = async event => {
  const button = event.currentTarget;
  const progress = startProgress('aiPosterProgress');
  const files = $('aiPosterRef').files;
  const assetFiles = files && files.length ? [...files].filter(f => f.type.startsWith('image/')) : [];
  const cmd = $('aiPosterCmd').value.trim();
  const extraText = $('aiPosterText').value.trim();
  const style = $('aiPosterStyle').value;
  const product = $('product').value;
  const needs = $('needs').value.trim();
  const instruction = cmd || `为${product}生成营销海报${needs ? `，需求：${needs}` : ''}`;
  const styleText = style ? `，整体风格：${style}` : '';
  const ctaHint = /CTA|按钮|引导|立即|了解详情/i.test(instruction) ? '' : '；如指令未指定行动按钮，可在底部放一句引导，如「登录服务市场了解详情」';
  const paletteText = /香槟|金色|轻奢|咖啡|深咖/.test(style)
    ? '除非用户指定，默认使用香槟金、暖白、深咖配色。'
    : '配色由主题与文案自然决定，丰富有层次、有明暗对比，避免全篇单一色调或一成不变的品牌色。';
  const psize = posterSizeInfo();
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const ratioText = `${psize.w / gcd(psize.w, psize.h)}:${psize.h / gcd(psize.w, psize.h)}`;
  const assetTextBlock = extraText
    ? `\n需要展示在画面中的文字内容（由 AI 自动排版，务必全部准确呈现、不得遗漏或改写）：\n${extraText}`
    : '';
  const assetHint = assetFiles.length
    ? `\n已提供 ${assetFiles.length} 张素材图片作为参考：请理解素材内容（产品图/对比表/示意图等），把素材以美观方式重新排版进海报（可裁剪、缩放、加圆角、配文字说明），不要直接照搬原图的文字排版。`
    : '';
  const prompt = `请生成一张${psize.label}${ratioText}（画布 ${psize.w}×${psize.h}）的完整酒店营销海报成品图，图片内直接包含准确的中文文字（无错别字、无乱码）。
主题：${product}。${styleText}
用户指令（请严格执行）：${instruction}
排版要求：标题醒目、卖点分条短句、信息层级清晰、高级商业广告质感${ctaHint}。${paletteText}${assetTextBlock}${assetHint}`;
  const aspectKey = psize.ratio > 1.1 ? '16:9' : (psize.ratio < 0.9 ? '9:16' : 'square');
  const genOpts = { aspect: aspectKey, size: psize.api };
  button.textContent = 'AI生成中…';
  $('aiPosterStatus').textContent = '';
  try {
    if (!hasByokImage()) {
      $('aiPosterStatus').textContent = imageConfigError();
      progress.stop();
      return;
    }
    let src;
    const imgCfg = getImageConfig();
    if (assetFiles.length) {
      let reference = null;
      try {
        reference = await Promise.race([
          composeAssetGrid(assetFiles),
          new Promise((_, reject) => setTimeout(() => reject(new Error('素材处理超时')), 20000))
        ]);
      } catch (gridError) {
        try {
          const { dataUrl } = await resizeImageFile(assetFiles[0], 1024);
          reference = dataUrl;
        } catch {
          reference = null;
        }
      }
      if (reference) {
        try {
          src = await openAILikeImage(prompt, { ...genOpts, reference });
        } catch (refError) {
          src = await openAILikeImage(prompt, genOpts);
          $('aiPosterStatus').textContent = `参考图编辑不可用（${refError.message}），已改用文字指令生成。`;
        }
      } else {
        src = await openAILikeImage(prompt, genOpts);
        $('aiPosterStatus').textContent = '素材图片读取失败，已改用纯文字指令生成。';
      }
    } else {
      src = await openAILikeImage(prompt, genOpts);
    }
    const image = new Image();
    image.src = src;
    await image.decode();
    snapshot();
    backgroundImage = image;
    backgroundInfo = { mode: 'ai-poster', style: style || '成品海报' };
    objects = objects.filter(object => object.type !== 'text');
    selected = null;
    draw();
    renderLayers();
    savePosterHistory({
      type: 'ai-poster',
      instruction,
      prompt,
      style: style || '跟随指令',
      engine: `${imgCfg.model}${(imgCfg.provider === 'dashscope' || imgCfg.provider === 'qianwen') && assetFiles.length ? '·素材参考编辑' : ''}`,
      width: canvas.width,
      height: canvas.height,
      image: await posterHistoryImage(src)
    });
    progress.done();
    $('aiPosterStatus').textContent = `成品海报已生成（引擎：${imgCfg.model}${(imgCfg.provider === 'dashscope' || imgCfg.provider === 'qianwen') && assetFiles.length ? '·素材参考编辑' : ''}）。画布已更新为成品海报，可直接下载或微调。`;
  } catch (error) {
    $('aiPosterStatus').textContent = `生成失败：${error.message}`;
    progress.fail();
  } finally {
    button.textContent = '🪄 AI 生成成品海报';
  }
};

/* 编辑 AI 海报：把当前画布海报作为参考图，按指令修改 */
$('aiEditBtn').onclick = async event => {
  const button = event.currentTarget;
  const progress = startProgress('aiEditProgress');
  const cmd = $('aiEditCmd').value.trim();
  if (!cmd) {
    progress.stop();
    return alert('先输入编辑指令');
  }
  if (!hasByokImage()) {
    $('aiEditStatus').textContent = imageConfigError();
    progress.stop();
    return;
  }
  const imgCfg = getImageConfig();
  if (imgCfg.provider !== 'dashscope' && imgCfg.provider !== 'qianwen') {
    $('aiEditStatus').textContent = '编辑需要参考图能力：请把图片服务商设为「阿里云百炼」或「千问AI平台 Token Plan（月付套餐）」（qwen-image-3.0 / qwen-image-3.0-pro）。';
    progress.stop();
    return;
  }
  button.textContent = '编辑中…';
  $('aiEditStatus').textContent = '';
  try {
    const maxSide = 1024;
    const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
    const temp = document.createElement('canvas');
    temp.width = Math.round(canvas.width * scale);
    temp.height = Math.round(canvas.height * scale);
    temp.getContext('2d').drawImage(canvas, 0, 0, temp.width, temp.height);
    const reference = temp.toDataURL('image/jpeg', 0.92);
    const psize = posterSizeInfo();
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const ratioText = `${psize.w / gcd(psize.w, psize.h)}:${psize.h / gcd(psize.w, psize.h)}`;
    const prompt = `请基于这张海报进行编辑，严格执行用户指令：${cmd}。只在必要处修改，保持整体风格协调，中文文字准确、无错别字、无乱码，${psize.label}${ratioText}（画布 ${psize.w}×${psize.h}），商业海报质感。`;
    const aspectKey = psize.ratio > 1.1 ? '16:9' : (psize.ratio < 0.9 ? '9:16' : 'square');
    const src = await openAILikeImage(prompt, { aspect: aspectKey, reference, size: psize.api });
    const image = new Image();
    image.src = src;
    await image.decode();
    snapshot();
    backgroundImage = image;
    backgroundInfo = { mode: 'ai-edit' };
    objects = objects.filter(object => object.type !== 'text');
    selected = null;
    draw();
    renderLayers();
    savePosterHistory({
      type: 'ai-edit',
      instruction: cmd,
      prompt,
      style: 'AI 编辑',
      engine: `${imgCfg.model}·参考图编辑`,
      width: canvas.width,
      height: canvas.height,
      image: await posterHistoryImage(src)
    });
    progress.done();
    $('aiEditStatus').textContent = `编辑完成（引擎：${imgCfg.model}·参考图编辑）。画布已更新为最新海报。`;
  } catch (error) {
    $('aiEditStatus').textContent = `编辑失败：${error.message}`;
    progress.fail();
  } finally {
    button.textContent = '✏️ 按指令编辑当前海报';
  }
};

/* ============================ 贴纸生成（多风格） ============================ */

async function pickPuterImageModel() {
  try {
    const models = await window.puter.ai.listModels?.();
    if (Array.isArray(models) && models.length) {
      const imageModels = models.filter(m => /gpt-image|dall-e|flux|sd3|image/i.test(String(m)));
      if (imageModels.length) return String(imageModels[0]);
    }
  } catch {}
  return 'gpt-image-1';
}

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
    let image;
    const styleDesc = STICKER_STYLE_DESC[style] || STICKER_STYLE_DESC['卡通萌趣'];
    const stickerPrompt = `原创贴纸，${style}：${subject}。${styleDesc}。单一主体居中，完整角色，粗线条轮廓，商业贴纸质感，画面干净，无文字，无Logo，不模仿任何版权角色。`;
    if (hasByokImage()) {
      const src = await openAILikeImage(stickerPrompt, { aspect: 'square' });
      image = new Image();
      image.src = src;
      await image.decode();
    } else {
      if (IS_GITHUB_PAGES) await ensurePuterAuth();
      try {
        if (IS_GITHUB_PAGES) throw new Error('使用公共AI');
        const data = await apiRequest('/api/sticker', { subject, style }, 30000);
        image = new Image();
        image.src = data.image;
        await image.decode();
      } catch (apiError) {
        if (!window.puter?.ai?.txt2img) throw new Error('Puter图片服务未加载');
        image = await window.puter.ai.txt2img(
          stickerPrompt,
          { model: await pickPuterImageModel(), ratio: '1:1', transparent_background: true }
        );
      }
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

// 把多张素材图拼成一张网格参考图（2列网格），作为 AI 排版海报的参考输入
async function composeAssetGrid(files) {
  const images = [];
  for (const file of files.slice(0, 6)) {
    const image = await new Promise((resolve, reject) => {
      loadImageFile(file, resolve);
      setTimeout(() => reject(new Error('图片读取超时')), 15000);
    });
    images.push(image);
  }
  if (!images.length) throw new Error('没有可用的素材图片');
  const cols = Math.min(2, images.length);
  const rows = Math.ceil(images.length / cols);
  const cell = 640;
  const gap = 12;
  const pad = 12;
  const canvas2 = document.createElement('canvas');
  canvas2.width = pad * 2 + cols * cell + (cols - 1) * gap;
  canvas2.height = pad * 2 + rows * cell + (rows - 1) * gap;
  const g = canvas2.getContext('2d');
  g.fillStyle = '#f4f1ec';
  g.fillRect(0, 0, canvas2.width, canvas2.height);
  images.forEach((image, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = pad + col * (cell + gap);
    const y = pad + row * (cell + gap);
    const ratio = Math.max(cell / image.width, cell / image.height);
    const sw = cell / ratio;
    const sh = cell / ratio;
    g.drawImage(image, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, x, y, cell, cell);
  });
  return canvas2.toDataURL('image/jpeg', 0.92);
}

async function puterVision(file) {
  if (!window.puter?.ai?.chat) throw new Error('公共AI不可用');
  const prompt = `分析这张酒店营销海报，只返回JSON：{"style_name":"一句话概括风格","colors":["#RRGGBB","#RRGGBB","#RRGGBB"],"layout":"构图方式描述","font_feel":"字体气质","tone":"文案语气","key_elements":["元素1","元素2"],"bg_prompt":"用于AI生成类似风格底图的英文描述，要求9:16竖版、无文字、无Logo、无版权角色","layout_guide":"排版建议"}。colors 必须从这张海报的实际主色中提取（取2-4个真实出现的主色），不要臆造或套用固定色。不要复制海报上的具体文字内容。`;
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
  const mode = $('learnMode').value;
  button.textContent = 'AI学习中…';
  $('posterLearnStatus').textContent = '正在分析参考海报的风格…';
  try {
    const { dataUrl, mime } = await resizeImageFile(file, 1024);
    const thumb = await resizeImageFile(file, 180);
    const ref = await resizeImageFile(file, 512);
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
      }
    }
    posterMemory.unshift({
      id: Date.now(),
      name: file.name,
      date: Date.now(),
      thumb: thumb.dataUrl,
      ref: ref.dataUrl,
      style
    });
    if (posterMemory.length > 12) posterMemory = posterMemory.slice(0, 12);
    lsSet(LS.posterMemory, posterMemory);
    renderPosterMemory();
    lsSet(LS.posterStyle, style);

    const learnedCount = posterMemory.length;
    const memoryStyle = aggregatePosterStyle() || style;
    let bgImage;

    if (mode === 'direct') {
      bgImage = new Image();
      bgImage.src = dataUrl;
      await bgImage.decode();
      snapshot();
      backgroundImage = bgImage;
      backgroundInfo = { mode: 'learn', style: '直接使用参考图' };
      objects = objects.filter(object => object.type !== 'text');
      selected = null;
      draw();
      renderLayers();
      $('posterLearnStatus').textContent = `已把参考图「${file.name}」设为底图（记忆第 ${learnedCount} 张）。可直接添加文案，或继续投喂。`;
    } else {
      $('posterLearnStatus').textContent = `正在用参考图生成相似海报（已综合 ${learnedCount} 张记忆）…`;
      const extras = posterMemory.slice(1, 4).map(item => item.ref).filter(Boolean);
      const images = [
        { data_b64: dataUrl.split(',')[1], mime },
        ...extras.map(src => ({
          data_b64: src.split(',')[1],
          mime: src.split(';')[0].split(':')[1]
        }))
      ];
      let data;
      try {
        if (IS_GITHUB_PAGES) throw new Error('use vercel');
        data = await apiRequest('/api/poster-edit', {
          images,
          product: $('product').value,
          scene: $('bgScene').value,
          description: $('bgDesc').value
        }, 60000);
      } catch (editError) {
        let learnedPrompt = `综合 ${learnedCount} 张参考海报的风格，为"${$('product').value}"生成9:16酒店营销海报底图。`;
        learnedPrompt += `参考风格：${memoryStyle?.style_name || ''}；主色：${(memoryStyle?.colors || []).join('、')}；构图：${memoryStyle?.layout || ''}；视觉元素：${(memoryStyle?.key_elements || []).join('、')}。`;
        learnedPrompt += `要求：保留参考海报的整体气质但内容全新，主体清晰、居中偏下，上方留出干净空白放标题，真实商业摄影质感，无文字、无Logo、无人脸、无抽象漂浮物。`;
        if (hasByokImage()) {
          try {
            const imgCfg = getImageConfig();
            const src = (imgCfg.provider === 'dashscope' || imgCfg.provider === 'qianwen')
              ? await openAILikeImage(learnedPrompt, { aspect: '9:16', reference: dataUrl })
              : await openAILikeImage(learnedPrompt, { aspect: '9:16' });
            bgImage = new Image();
            bgImage.src = src;
            await bgImage.decode();
            snapshot();
            backgroundImage = bgImage;
            backgroundInfo = { mode: 'learn', style: '自填AI图生图' };
            const colors = {
              accent: style?.colors?.[0] || '#c07c28',
              ink: style?.colors?.[1] || '#8c6846',
              sub: style?.colors?.[2] || '#5e4a39'
            };
            applyPosterCopy(localPosterCopy(), colors);
            $('posterLearnStatus').textContent = `完成！已参考 ${learnedCount} 张海报生成相似底图并排版（引擎：${imgCfg.model}${(imgCfg.provider === 'dashscope' || imgCfg.provider === 'qianwen') ? '·参考图编辑' : ''}）。投喂越多越接近你的风格。`;
            return;
          } catch (byokError) {}
        }
        bgImage = new Image();
        bgImage.src = dataUrl;
        await bgImage.decode();
        snapshot();
        backgroundImage = bgImage;
        backgroundInfo = { mode: 'learn', style: '直接使用参考图' };
        objects = objects.filter(object => object.type !== 'text');
        selected = null;
        draw();
        renderLayers();
        $('posterLearnStatus').textContent = `AI 模仿生成暂不可用（${editError.message}），已用参考图直接作为底图。配置 Google AI Key 或在 AI 设置填图片模型后可启用真正的图生图。`;
        return;
      }
      bgImage = new Image();
      bgImage.src = data.image;
      await bgImage.decode();
      snapshot();
      backgroundImage = bgImage;
      backgroundInfo = { mode: 'learn', style: style?.style_name || 'AI模仿生成' };
      const colors = {
        accent: style?.colors?.[0] || '#c07c28',
        ink: style?.colors?.[1] || '#8c6846',
        sub: style?.colors?.[2] || '#5e4a39'
      };
      applyPosterCopy(localPosterCopy(), colors);
      $('posterLearnStatus').textContent = `完成！已参考 ${learnedCount} 张海报生成相似底图并排版（引擎：Gemini Nano Banana 同款模型）。投喂越多越接近你的风格。`;
    }
  } catch (error) {
    $('posterLearnStatus').textContent = `海报学习失败：${error.message}`;
  } finally {
    button.textContent = 'AI学习并生成类似海报';
  }
};

/* ============================ 海报尺寸 / 下载 ============================ */

function posterSizeInfo() {
  const w = canvas.width;
  const h = canvas.height;
  const ratio = w / h;
  const label = ratio > 1.15 ? '横版' : (ratio < 0.87 ? '竖版' : '方形');
  const scale = Math.min(1, 2048 / Math.max(w, h));
  return { w, h, ratio, label, api: `${Math.round(w * scale)}*${Math.round(h * scale)}` };
}

function setPosterSize(width, height) {
  const w = Math.min(4096, Math.max(200, Math.round(width)));
  const h = Math.min(4096, Math.max(200, Math.round(height)));
  const ratioX = w / canvas.width;
  const ratioY = h / canvas.height;
  const s = Math.min(ratioX, ratioY);
  snapshot();
  canvas.width = w;
  canvas.height = h;
  objects = objects.map(object => {
    const next = { ...object, x: object.x * ratioX, y: object.y * ratioY };
    if (object.type === 'text') {
      next.size = object.size * s;
      next.width = (object.width || 400) * ratioX;
      next.height = (object.height || object.size) * s;
    } else {
      next.scale = (object.scale || 1) * s;
    }
    return next;
  });
  selected = null;
  draw();
  renderLayers();
  updateHistoryButtons();
  $('posterWidth').value = w;
  $('posterHeight').value = h;
  const status = $('sizeStatus');
  if (status) status.textContent = `画布已调整为 ${w}×${h}（${posterSizeInfo().label}）。后续生成与下载都按这个尺寸。`;
}

$('applySize').onclick = () => {
  const w = parseInt($('posterWidth').value, 10);
  const h = parseInt($('posterHeight').value, 10);
  if (!w || !h || w < 200 || w > 4096 || h < 200 || h > 4096) {
    $('sizeStatus').textContent = '宽高需在 200–4096 像素之间。';
    return;
  }
  setPosterSize(w, h);
};
$('sizePresets').querySelectorAll('button').forEach(button => {
  button.onclick = () => setPosterSize(+button.dataset.w, +button.dataset.h);
});

$('download').onclick = () => {
  selected = null;
  draw();
  const anchor = document.createElement('a');
  anchor.download = `TripMALL营销海报_${canvas.width}x${canvas.height}.png`;
  anchor.href = canvas.toDataURL('image/png');
  anchor.click();
};

/* ============================ 初始化 ============================ */

updateHistoryButtons();
draw();
