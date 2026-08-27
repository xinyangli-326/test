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
  const model = cfg.imageModel || (providerKey === 'qianwen' || providerKey === 'dashscope' ? 'qwen-image-3.0-pro' : provider.imageModel);
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

async function openAILikeChat(system, user, { maxTokens = 3000, temperature = 0.85, deep = false } = {}) {
  const cfg = getAIConfig();
  const provider = AI_PROVIDERS[cfg.provider] || AI_PROVIDERS.custom;
  // 深度思考：优先切到带思考能力的模型
  const deepModel = {
    deepseek: 'deepseek-reasoner',
    siliconflow: 'deepseek-ai/DeepSeek-R1',
    dashscope: 'qwen3-max',
    qianwen: 'qwen3.7-max',
    zhipu: 'glm-4-plus',
    moonshot: 'kimi-latest',
    openai: 'gpt-4o'
  }[cfg.provider] || '';
  const effModel = deep && deepModel ? deepModel : (cfg.model || provider.model);
  if (deep) maxTokens = Math.max(maxTokens, 8000);
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
          model: effModel,
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
  const model = effModel || 'gpt-4o-mini';
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

async function dashscopeImage(prompt, { aspect = 'square', reference = null, size = '', strictRef = false, onStatus = null } = {}) {
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
    // 严格对齐阿里云控制台生成海报的初始设置：
    // 不传 size（分辨率由模型 auto 推荐）、不传 prompt_extend / negative_prompt 等自定义参数，
    // 只发 model + 指令，跟官网试用完全一致（qwen-image-3.0 / 3.0-pro 通用）
  } else {
    // Token Plan 官方示例与旧版 qwen-image 都支持 size；参考图编辑时百炼 qwen-image-edit 不传 size
    if (!isEdit || isTokenPlan) {
      parameters.size = size || (aspect === '9:16' ? '1080*1920' : (aspect === '16:9' ? '1920*1080' : '1024*1024'));
    }
    if (!isEdit) {
      parameters.negative_prompt = '低质量、模糊、畸形、水印、杂乱构图、乱码、白边、白框';
    }
  }
  // Token Plan 接口未开放浏览器跨域（官方设计给服务端工具用），优先走网站自带中转；
  // 中转不可用时才尝试直连（直连在浏览器里通常会因跨域失败）
  let proxyError = null;
  if (isTokenPlan && API_BASE) {
    // 先做一次轻量健康自检：快速区分"中转不可达"（网络问题）与"生成超时"，
    // 避免用户等完整生成后才看到 Failed to fetch
    try {
      const healthResp = await fetch(apiUrl('/api/health'), { signal: AbortSignal.timeout(8000) });
      if (!healthResp.ok) throw new Error('HTTP ' + healthResp.status);
    } catch (healthError) {
      throw new Error(`中转服务不可达：当前网络访问不了 test-xinyang.vercel.app（${healthError.message || 'Failed to fetch'}）。请先在你浏览器打开 https://test-xinyang.vercel.app/api/health 自测：打不开 = 本地网络/运营商拦截（公司 VPN 环境下通常可访问）；若确认打不开，请把图片服务商换成「阿里云百炼（按量）直连」（浏览器可直连、不依赖中转），或换到能访问 vercel.app 的网络重试。`);
    }
    const proxyBody = {
      apiKey: img.key,
      model,
      prompt,
      reference: isEdit ? reference : '',
      size: parameters.size || '',
      prompt_extend: parameters.prompt_extend === undefined ? undefined : !!parameters.prompt_extend,
      negative_prompt: parameters.negative_prompt || '',
      watermark: parameters.watermark !== false
    };
    // 异步任务制（推荐）：提交秒回 task_id，再轮询结果，绕开中转 60 秒上限
    let taskId = '';
    try {
      const submitResp = await fetch(apiUrl('/api/token-plan-image-async'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify(proxyBody)
      });
      const submitCt = submitResp.headers.get('content-type') || '';
      if (!submitCt.includes('application/json')) {
        throw new Error('中转后端返回的不是 JSON（可能被 Vercel 部署保护/认证页拦截）');
      }
      const submitData = await submitResp.json();
      if (!submitResp.ok) throw new Error(submitData.error || `中转接口错误（${submitResp.status}）`);
      taskId = submitData.task_id || '';
      if (!taskId) throw new Error(submitData.error || '异步提交未返回任务 ID');
    } catch (error) {
      proxyError = error;
    }
    if (taskId) {
      try {
        const startedAt = Date.now();
        while (Date.now() - startedAt < 600000) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          const taskResp = await fetch(apiUrl('/api/token-plan-image-task'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(25000),
            body: JSON.stringify({ task_id: taskId, apiKey: img.key })
          });
          const taskData = await taskResp.json().catch(() => ({}));
          if (!taskResp.ok) throw new Error(taskData.error || `任务查询失败（${taskResp.status}）`);
          const status = String(taskData.task_status || 'RUNNING');
          if (status === 'SUCCEEDED' && taskData.image_url) {
            if (typeof onStatus === 'function') onStatus('已完成，正在下载图片');
            return toSafeDataURL(taskData.image_url);
          }
          if (status === 'FAILED') {
            throw new Error(taskData.message || '图片任务生成失败');
          }
          if (typeof onStatus === 'function') onStatus(status === 'RUNNING' ? '模型生成中（异步任务）' : status);
        }
        throw new Error('图片任务超过 10 分钟仍未完成，请稍后重试');
      } catch (error) {
        proxyError = error;
      }
    } else {
      // 异步提交不可用（如套餐模型不支持异步）时，回退旧同步中转（任务未创建，不会重复扣费）
      try {
        const proxyResp = await fetch(apiUrl('/api/token-plan-image'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(75000),
          body: JSON.stringify(proxyBody)
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
    if (isV3 && last.size) attempts.push({ ...last, size: undefined });
    if (isV3 && last.prompt_extend) attempts.push({ ...last, prompt_extend: false });
    if (attempts[attempts.length - 1].negative_prompt) attempts.push({ ...attempts[attempts.length - 1], negative_prompt: undefined });
    if (attempts[attempts.length - 1].watermark) attempts.push({ ...attempts[attempts.length - 1], watermark: false });
    for (const params of attempts.slice(1)) {
      const retry = await call(usedEndpoint, params).catch(() => null);
      if (retry && retry.ok) { response = retry; break; }
    }
  }
  if (!response) {
    if (isTokenPlan) {
      throw new Error(
        `Token Plan 接口不支持浏览器直连（官方未开放跨域），必须走服务端中转；中转调用失败：${proxyError ? proxyError.message : '中转后端未部署或不可达'}。请先在你浏览器打开 https://test-xinyang.vercel.app/api/health 自测：打不开 = 当前网络访问不了该中转（公司 VPN 环境下通常可访问），请换网络或改用「阿里云百炼（按量）直连」（浏览器可直连、不依赖中转，参考图编辑同样可用）；若 health 能打开但生成超时，说明中转 60 秒上限被触发，可把参考图再压缩后重试。`
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

async function openAILikeImage(prompt, { aspect = 'square', reference = null, size = '', strictRef = false, onStatus = null } = {}) {
  const img = getImageConfig();
  if (!img) throw new Error(imageConfigError());
  if (img.provider === 'dashscope' || img.provider === 'qianwen') return dashscopeImage(prompt, { aspect, reference, size, strictRef, onStatus });
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

/* 海报区实时显示"实际连接的图片引擎"，避免选了 pro 却连到普通版还不自知 */
function updatePosterEngineLine() {
  const el = $('posterEngineLine');
  if (!el) return;
  const img = getImageConfig();
  if (!img) {
    el.textContent = '当前图片引擎：未配置（请在 AI 设置 → 图片生成 选择阿里云百炼并保存）';
    return;
  }
  const mode = img.provider === 'qianwen' ? 'Token Plan 中转' : '百炼直连';
  el.textContent = img.provider === 'qianwen'
    ? `当前图片引擎：${img.model}（${mode}，依赖 test-xinyang.vercel.app）—— 若生成报 Failed to fetch，说明当前网络访问不了该中转，可改用「阿里云百炼（按量）直连」`
    : `当前图片引擎：${img.model}（${mode}）—— 浏览器可直接调用，与阿里云控制台同参数`;
}

/* 图片模型：下拉选项与"自定义模型"输入框联动 */
function setImageModel(value) {
  const sel = $('aiImageModel');
  const custom = $('aiImageModelCustom');
  if (!sel) return;
  const v = String(value || '').trim();
  if (!custom) { sel.value = v; return; }
  if (!v) { sel.value = ''; custom.value = ''; custom.hidden = true; return; }
  const known = Array.from(sel.options).some(o => o.value === v);
  if (known) {
    sel.value = v;
    custom.hidden = true;
  } else {
    sel.value = '__custom__';
    custom.value = v;
    custom.hidden = false;
  }
}

function imageModelValue() {
  const sel = $('aiImageModel');
  if (!sel) return '';
  if (sel.value === '__custom__') {
    const custom = $('aiImageModelCustom');
    return custom ? (custom.value || '').trim() : '';
  }
  return sel.value || '';
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
  setImageModel(cfg.imageModel || '');
  $('aiImageBaseUrl').value = cfg.imageBaseUrl || '';
  // 仅旧默认（空 / 远古 qwen-image）自动升级为 pro；用户明确选的 qwen-image-3.0 常规版保持不变
  if ((cfg.imageProvider === 'dashscope' || cfg.imageProvider === 'qianwen') && ['', 'qwen-image'].includes((cfg.imageModel || '').trim())) {
    setImageModel('qwen-image-3.0-pro');
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
  // 仅当图片服务商是「跟随文字服务商」时才联动图片模型，避免覆盖用户已单独选好的 pro/常规版
  if (!$('aiImageProvider').value) setImageModel(provider.imageModel);
};
$('aiModelSuggest').onclick = () => {
  const provider = AI_PROVIDERS[$('aiProvider').value] || AI_PROVIDERS.custom;
  if (provider.recommend) $('aiModel').value = provider.recommend;
  else alert('该服务商暂无推荐模型，请手动填写。');
};
$('aiImageProvider').onchange = () => {
  const key = $('aiImageProvider').value;
  if (key === 'siliconflow') {
    setImageModel('black-forest-labs/FLUX.1-schnell');
    $('aiImageBaseUrl').value = 'https://api.siliconflow.cn/v1';
  } else if (key === 'dashscope') {
    setImageModel('qwen-image-3.0-pro');
    $('aiImageBaseUrl').value = 'https://dashscope.aliyuncs.com';
  } else if (key === 'qianwen') {
    setImageModel('qwen-image-3.0-pro');
    $('aiImageBaseUrl').value = 'https://token-plan.cn-beijing.maas.aliyuncs.com';
  } else if (key === 'zhipu') {
    setImageModel('cogview-4-250304');
    $('aiImageBaseUrl').value = 'https://open.bigmodel.cn/api/paas/v4';
  } else if (key === 'openai') {
    setImageModel('gpt-image-1');
    $('aiImageBaseUrl').value = 'https://api.openai.com/v1';
  } else if (key === 'custom') {
    setImageModel('__custom__');
    $('aiImageBaseUrl').value = '';
  }
};
$('aiImageModel').onchange = () => {
  const custom = $('aiImageModelCustom');
  if (!custom) return;
  if ($('aiImageModel').value === '__custom__') {
    custom.hidden = false;
    custom.focus();
  } else {
    custom.hidden = true;
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
    setImageModel(suggestions[key]);
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
    imageModel: imageModelValue(),
    imageBaseUrl: $('aiImageBaseUrl').value.trim()
  };
  lsSet(AI_KEY, cfg);
  updateAIStatus();
  updatePosterEngineLine();
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
  setImageModel('');
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
    const resp = await fetch(apiUrl('/api/knowledge?' + cacheBust)).catch(() => null) ||
      await fetch('knowledge_base.json?' + cacheBust);
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

// 用户已开通 qwen-image-3.0-pro：页面加载时仅把百炼/Token Plan 的旧默认图片模型（空 / qwen-image）升级为 pro，
// 用户明确选择的 qwen-image-3.0 常规版保持不变
(() => {
  const cfg = getAIConfig();
  if ((cfg.imageProvider === 'dashscope' || cfg.imageProvider === 'qianwen') && ['', 'qwen-image'].includes((cfg.imageModel || '').trim())) {
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
    imageModel: imageModelValue(),
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
    imageModel: imageModelValue(),
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
updatePosterEngineLine();

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
  renderKbPosterImages();
}

/* 知识库配图：帮助文档里的官方截图，点击选作海报参考图 */
let selectedKbImage = '';

function currentHelpImages() {
  const cat = knowledge.categories[$('category').value] || {};
  const docs = Array.isArray(cat.help_docs) ? cat.help_docs : [];
  const images = [];
  docs.forEach(doc => (doc.images || []).forEach(file => images.push({ doc: doc.title, file })));
  return images;
}

function renderKbPosterImages() {
  const box = $('kbPosterImgs');
  if (!box) return;
  const images = currentHelpImages();
  if (!images.length) {
    box.innerHTML = '<span class="hint">当前知识库分类暂无配图（平台/支付类帮助文档里有官方截图）</span>';
    return;
  }
  box.innerHTML = images.map((img, i) => `
    <button type="button" class="kb-img${selectedKbImage === img.file ? ' on' : ''}" data-i="${i}" title="${escapeHtml(img.doc)}">
      <img src="${escapeHtml(img.file)}" alt="">
    </button>`).join('');
  box.querySelectorAll('.kb-img').forEach(btn => {
    btn.onclick = () => {
      const img = images[+btn.dataset.i];
      selectedKbImage = selectedKbImage === img.file ? '' : img.file;
      renderKbPosterImages();
      $('aiPosterStatus').textContent = selectedKbImage ? `已选知识库配图作为参考：${img.doc}（可再点取消）` : '';
    };
  });
}

function renderCategoryCards() {
  $('categories').innerHTML = Object.entries(knowledge.categories).map(([key, value], index) => {
    const topics = Array.isArray(value.topics) ? value.topics : Object.keys(value.topics || {});
    const larkDocs = Array.isArray(knowledge.lark?.docs) ? knowledge.lark.docs : [];
    const larkDoc = larkDocs.find(doc => doc.key === key) || {};
    const docUrl = larkDoc.url || value.doc_url || '';
    const docLink = docUrl
      ? `<a class="cat-doc" href="${escapeHtml(docUrl)}" target="_blank" rel="noopener">📄 查看飞书文档 ↗</a>`
      : '';
    return `<article class="cat reveal" style="transition-delay:${index * 70}ms">
      <b>${escapeHtml(value.name)}</b>
      <p>${escapeHtml(value.description || '持续沉淀酒店行业可复用内容。')}</p>
      <ul>${topics.slice(0, 5).map(topic => `<li>${escapeHtml(topic)}</li>`).join('')}</ul>
      ${docLink}
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
  const syncedDocs = Array.isArray(data.lark?.synced_docs)
    ? data.lark.synced_docs
    : (Array.isArray(data.lark?.docs) ? data.lark.docs : []);
  const larkDocs = syncedDocs.filter(doc => doc && doc.text && doc.text.trim());
  if (larkDocs.length) {
    knowledge.lark_docs = larkDocs;
    $('larkStatus').textContent = `飞书内容库：已同步 ${larkDocs.length} 篇${data.lark.synced_at ? ' · ' + data.lark.synced_at : ''}`;
    lsSet(LARK_CACHE_KEY, { docs: larkDocs, synced_at: data.lark.synced_at || '' });
  } else {
    const firstErr = syncedDocs.find(doc => doc && doc.error) || null;
    const errText = (firstErr && firstErr.error) || data.lark?.last_error;
    if (errText) $('larkStatus').textContent = `飞书内容库：自动同步不可用（${errText}）`;
  }
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
  return fetch(apiUrl('/api/knowledge?' + cacheBust)).then(response => {
    if (!response.ok) throw new Error('live kb unavailable');
    return response.json();
  }).then(applyKnowledge).catch(() => {
    return fetch('knowledge_base.json?' + cacheBust).then(response => {
      if (!response.ok) throw new Error('local kb unavailable');
      return response.json();
    }).then(applyKnowledge).catch(() => {});
  });
}

/* ============================ 飞书内容库同步 ============================ */

const LARK_CACHE_KEY = 'tripMall.larkDocs';

function larkDocsConfig() {
  const docs = knowledge.lark?.docs;
  if (Array.isArray(docs) && docs.length) return docs;
  return [{ key: 'product', name: '产品类内容库', url: 'https://trip.larkenterprise.com/docx/ArYQdJsHHoDSSJxgYozci92onsf' }];
}

function applyLarkDocs(docs, syncedAt) {
  const ok = (docs || []).filter(doc => doc && doc.text && doc.text.trim());
  const failed = (docs || []).filter(doc => doc && doc.error);
  knowledge.lark_docs = ok;
  let status;
  if (!ok.length) {
    status = failed.length
      ? `飞书内容库：同步失败（${failed[0].error}）`
      : '飞书内容库：未同步';
  } else {
    const totalChars = ok.reduce((sum, doc) => sum + doc.text.length, 0);
    status = `飞书内容库：已同步 ${ok.length} 篇${syncedAt ? ' · ' + syncedAt : ''}`;
    if (totalChars >= 1000) status += `（约 ${Math.round(totalChars / 100) / 10} 千字）`;
  }
  if (failed.length) status += `；${failed.length} 篇失败`;
  $('larkStatus').textContent = status;
  lsSet(LARK_CACHE_KEY, { docs: ok, synced_at: syncedAt || '' });
  renderCategoryCards();
}

async function syncLark() {
  const btn = $('larkSyncBtn');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '同步中…';
  try {
    const resp = await fetch(apiUrl('/api/lark-sync'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docs: larkDocsConfig() })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `同步失败（${resp.status}）`);
    applyLarkDocs(data.docs, data.synced_at);
  } catch (error) {
    $('larkStatus').textContent = `飞书内容库：同步失败（${error.message}）`;
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
}

function initLark() {
  const cached = lsGet(LARK_CACHE_KEY);
  if (cached && Array.isArray(cached.docs)) {
    knowledge.lark_docs = cached.docs;
    $('larkStatus').textContent = `飞书内容库：已缓存 ${cached.docs.length} 篇${cached.synced_at ? ' · ' + cached.synced_at : ''}`;
  }
  if ($('larkSyncBtn')) $('larkSyncBtn').onclick = syncLark;
  syncLark();
}

function slugifyLarkName(name) {
  const s = String(name || '飞书内容库').trim();
  return s.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, '-').slice(0, 24) || 'lark-manual';
}

function pasteLark() {
  const text = $('larkPasteText').value.trim();
  const status = $('larkStatus');
  if (!text) {
    status.textContent = '飞书内容库：请先粘贴文档正文再入库。';
    return;
  }
  const name = $('larkPasteName').value.trim() || '飞书内容库（手动）';
  const key = slugifyLarkName(name);
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const doc = { key, name, text: text.slice(0, 30000), updated_at: '手动·' + now, source: 'paste' };
  const docs = Array.isArray(knowledge.lark_docs) ? knowledge.lark_docs.filter(item => item.key !== key) : [];
  docs.unshift(doc);
  knowledge.lark_docs = docs;
  lsSet(LARK_CACHE_KEY, { docs, synced_at: now });
  $('larkPasteText').value = '';
  $('larkPasteName').value = '';
  status.textContent = `飞书内容库：已入库「${name}」（约 ${Math.round(text.length / 100) / 10} 千字），生成时自动参考。`;
}

async function readClipboardLark() {
  const status = $('larkStatus');
  try {
    const text = await navigator.clipboard.readText();
    if (!text || !text.trim()) {
      status.textContent = '飞书内容库：剪贴板是空的，请先在飞书文档里 Ctrl+A / Ctrl+C 复制正文。';
      return;
    }
    $('larkPasteText').value = text.trim().slice(0, 30000);
    status.textContent = '飞书内容库：已从剪贴板读取，确认无误后点「入库并应用」。';
  } catch (error) {
    status.textContent = '飞书内容库：浏览器不允许直接读剪贴板，请在输入框里 Ctrl+V 粘贴。';
  }
}

function larkRelevant(query, maxChars = 900, maxDocs = 1) {
  const docs = Array.isArray(knowledge.lark_docs) ? knowledge.lark_docs : [];
  if (!docs.length) return '';
  const q = String(query || '');
  const keys = ['宠物', '亲子', '影音', '舒睡', '布草', '床垫', '毛巾', '牙具', '机器人', '咖啡', '采购', '优惠', '价格', '活动', '售后', '支付', '发票', '免房', '旅拍', '酒店', '客房'];
  const score = text => {
    let s = 0;
    keys.forEach(k => { if (q.includes(k) && text.includes(k)) s += 2; });
    q.split(/[\s,，。;；、]+/).filter(w => w.length >= 2).forEach(w => { if (text.includes(w)) s += 1; });
    return s;
  };
  const ranked = docs
    .map(d => ({ d, s: score((d.name || '') + ' ' + (d.text || '')) }))
    .sort((a, b) => b.s - a.s);
  const picked = ranked[0] && ranked[0].s > 0 ? ranked.slice(0, maxDocs) : docs.slice(0, maxDocs);
  return picked.map(x => `【${x.d.name || x.d.key}（更新于 ${x.d.updated_at || '—'}）】\n${String(x.d.text || '').slice(0, maxChars)}`).join('\n\n');
}

if ($('larkPasteBtn')) $('larkPasteBtn').onclick = pasteLark;
if ($('larkPasteClip')) $('larkPasteClip').onclick = readClipboardLark;

loadKnowledge();
initLark();

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
  structure: 'tripMall.structure',
  materials: 'tripMall.materials',
  posterStyle: 'tripMall.posterStyle',
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

function startProgress(barId, durationMs = 20000) {
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
  const interval = 170;
  const totalTicks = Math.max(10, Math.round((durationMs || 20000) / interval));
  const stepBase = 98 / totalTicks;
  const tick = () => {
    if (finished) return;
    // 按预估时长推进：整体在 durationMs 内缓慢爬到 99%，完成时拉满
    let step = stepBase * (0.55 + Math.random() * 0.9);
    if (progress > 85) step *= 0.4;
    else if (progress > 70) step *= 0.7;
    progress = Math.min(99, progress + step);
    pct.textContent = Math.floor(progress) + '%';
    fill.style.width = Math.floor(progress) + '%';
    timer = setTimeout(tick, interval);
  };
  timer = setTimeout(tick, interval);
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
  if (copyHistory.length > 500) copyHistory = copyHistory.slice(0, 500);
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
  // 不设人为条数上限：尽量多保留历史。
  // localStorage 空间不够时自动淘汰最旧记录，保证历史始终可用（浏览器存储本身有限，这是唯一硬限制）
  while (posterHistory.length && !lsSet(LS.posterHistory, posterHistory)) posterHistory.pop();
}

async function posterHistoryImage(src, maxSide = 900, quality = 0.78) {
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

const HISTORY_PAGE_SIZE = 10;
let historyState = { kind: 'copy', page: 0 };

function openHistory(kind) {
  historyState = { kind, page: 0 };
  $('historyDetail').hidden = true;
  $('historyList').hidden = false;
  $('historyTitle').textContent = kind === 'copy' ? '文案历史记录' : '海报历史记录';
  $('historyHint').textContent = kind === 'copy'
    ? '缩略列表：日期 · 知识库大类 · 渠道 · 主题。点击进入详情。'
    : '缩略列表：日期 · 类型 · 指令摘要。点击进入详情。';
  renderHistoryList();
  $('historyModal').hidden = false;
  const box = $('historyModal').querySelector('.modal-box');
  if (box) box.scrollTop = 0;
}

function historyData() {
  return historyState.kind === 'copy' ? copyHistory : posterHistory;
}

function historySummary(item) {
  if (historyState.kind === 'copy') {
    const catName = knowledge.categories?.[item.category]?.name || item.category || '';
    return `${fmtTime(item.time)}  ${catName || '未分类'}  ${item.channel || ''}  ${String(item.product || item.content || '').slice(0, 18)}`;
  }
  const typeLabel = item.type === 'ai-edit' ? 'AI 编辑' : '成品海报';
  return `${fmtTime(item.time)}  ${typeLabel}  ${String(item.instruction || item.style || '').slice(0, 22)}`;
}

function renderHistoryPager(total, page) {
  const pager = $('historyPager');
  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  if (pages <= 1) { pager.innerHTML = ''; return; }
  const btns = [];
  if (page > 0) btns.push(`<button type="button" data-page="${page - 1}">‹ 上一页</button>`);
  btns.push(`<span class="pager-info">${page + 1} / ${pages}</span>`);
  if (page < pages - 1) btns.push(`<button type="button" data-page="${page + 1}">下一页 ›</button>`);
  pager.innerHTML = btns.join('');
  pager.querySelectorAll('button[data-page]').forEach(btn => {
    btn.onclick = () => {
      historyState.page = +btn.dataset.page;
      renderHistoryList();
    };
  });
}

function renderHistoryList() {
  const list = $('historyList');
  const data = [...historyData()].sort((a, b) => b.time - a.time);
  const total = data.length;
  const page = Math.min(historyState.page, Math.max(0, Math.ceil(total / HISTORY_PAGE_SIZE) - 1));
  historyState.page = page;
  if (!total) {
    list.innerHTML = `<p class="history-empty">还没有${historyState.kind === 'copy' ? '文案' : '海报'}生成记录，先生成一条吧。</p>`;
    $('historyPager').innerHTML = '';
    return;
  }
  const slice = data.slice(page * HISTORY_PAGE_SIZE, (page + 1) * HISTORY_PAGE_SIZE);
  list.innerHTML = slice.map(item => {
    const isCopy = historyState.kind === 'copy';
    return `<div class="history-row" data-id="${item.id}" role="button">
      <span class="history-summary">${escapeHtml(historySummary(item))}</span>
      <span class="history-arrow">›</span>
    </div>`;
  }).join('');
  list.querySelectorAll('.history-row').forEach(row => {
    row.onclick = () => {
      const record = historyData().find(item => item.id === Number(row.dataset.id));
      if (record) openHistoryDetail(record);
    };
  });
  renderHistoryPager(total, page);
}

function openHistoryDetail(record) {
  const list = $('historyList');
  const detail = $('historyDetail');
  list.hidden = true;
  $('historyPager').innerHTML = '';
  detail.hidden = false;
  if (historyState.kind === 'copy') {
    const catName = knowledge.categories?.[record.category]?.name || record.category || '';
    detail.innerHTML = `
      <div class="history-detail-head">
        <button type="button" data-back class="alt">‹ 返回列表</button>
        <span class="history-time">${fmtTime(record.time)}</span>
        ${catName ? `<span class="badge">${escapeHtml(catName)}</span>` : ''}
        ${record.channel ? `<span class="badge">${escapeHtml(record.channel)}</span>` : ''}
        ${record.product ? `<span class="badge">${escapeHtml(record.product)}</span>` : ''}
      </div>
      <div class="history-detail-meta">
        ${record.persona ? `<div><b>视角：</b>${escapeHtml(record.persona)}</div>` : ''}
        ${record.content_type ? `<div><b>类型：</b>${escapeHtml(record.content_type)}</div>` : ''}
        ${record.needs ? `<div><b>需求：</b>${escapeHtml(record.needs)}</div>` : ''}
      </div>
      <div class="history-body">${escapeHtml(record.content)}</div>
      <textarea class="history-edit" rows="10" hidden>${escapeHtml(record.content)}</textarea>
      <div class="history-detail-actions">
        <button type="button" data-copy>复制</button>
        <button type="button" data-edit>编辑</button>
        <button type="button" class="danger" data-del>删除</button>
      </div>`;
    const body = detail.querySelector('.history-body');
    const editor = detail.querySelector('.history-edit');
    detail.querySelector('[data-copy]').onclick = async () => {
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
    detail.querySelector('[data-edit]').onclick = () => {
      editor.hidden = !editor.hidden;
      if (!editor.hidden) editor.focus();
    };
    editor.addEventListener('blur', () => {
      if (editor.value !== record.content) {
        record.content = editor.value;
        body.textContent = record.content;
        lsSet(LS.copyHistory, copyHistory);
      }
      editor.hidden = true;
    });
  } else {
    detail.innerHTML = `
      <div class="history-detail-head">
        <button type="button" data-back class="alt">‹ 返回列表</button>
        <span class="history-time">${fmtTime(record.time)}</span>
        <span class="badge">${record.type === 'ai-edit' ? 'AI 编辑' : '成品海报'}</span>
        ${record.style ? `<span class="badge">${escapeHtml(record.style)}</span>` : ''}
      </div>
      <div class="history-poster-detail">
        <img src="${record.image}" alt="海报预览">
        <div class="history-meta">
          <div><b>指令：</b><span class="clip">${escapeHtml(record.instruction)}</span></div>
          <div><b>引擎：</b>${escapeHtml(record.engine || '—')}</div>
          <div><b>尺寸：</b>${record.width}×${record.height}</div>
        </div>
      </div>
      <textarea class="history-edit" rows="4" hidden>${escapeHtml(record.instruction)}</textarea>
      <div class="history-detail-actions">
        <button type="button" data-load>继续编辑</button>
        <button type="button" data-edit>修改说明</button>
        <button type="button" class="danger" data-del>删除</button>
      </div>`;
    const editor = detail.querySelector('.history-edit');
    detail.querySelector('[data-load]').onclick = () => {
      loadPosterRecord(record);
      $('historyModal').hidden = true;
    };
    detail.querySelector('[data-edit]').onclick = () => {
      editor.hidden = !editor.hidden;
      if (!editor.hidden) editor.focus();
    };
    editor.addEventListener('blur', () => {
      if (record && editor.value !== record.instruction) {
        record.instruction = editor.value;
        lsSet(LS.posterHistory, posterHistory);
      }
      editor.hidden = true;
    });
  }
  detail.querySelector('[data-back]').onclick = () => {
    detail.hidden = true;
    list.hidden = false;
    renderHistoryPager(historyData().length, historyState.page);
  };
  detail.querySelector('[data-del]').onclick = () => {
    if (!confirm('确定删除这条历史记录吗？')) return;
    const key = historyState.kind === 'copy' ? LS.copyHistory : LS.posterHistory;
    const arr = historyState.kind === 'copy' ? copyHistory : posterHistory;
    const next = arr.filter(item => item.id !== record.id);
    if (historyState.kind === 'copy') copyHistory = next; else posterHistory = next;
    lsSet(key, next);
    detail.hidden = true;
    list.hidden = false;
    historyState.page = 0;
    renderHistoryList();
  };
}

function loadPosterRecord(record) {
  const image = new Image();
  image.onload = () => {
    // 画布自动匹配海报本身的比例/尺寸，避免用残留画布尺寸 cover 裁剪截断海报
    const iw = image.naturalWidth || image.width;
    const ih = image.naturalHeight || image.height;
    const iRatio = iw / ih;
    let w = Math.round(record.width || 0);
    let h = Math.round(record.height || 0);
    if (!(w >= 200 && h >= 200) || Math.abs((w / h) - iRatio) > 0.03) {
      if (iRatio >= 1) {
        w = 1440;
        h = Math.round(1440 / iRatio);
      } else {
        h = 1440;
        w = Math.round(1440 * iRatio);
      }
    }
    setPosterSize(w, h);
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
  const prompt = `你是资深中文文案编辑。从以下素材中提炼“风格画像”和“文章结构画像”，让之后只凭简短提示词就能生成同风格、同结构的内容。
素材：
${fullSource.slice(0, 20000)}
请严格按以下两个分节标题输出（不要输出其他内容）：
【风格画像】包含：1)整体语气；2)高频句式与开头方式；3)常用词与口头禅；4)内容长度与信息密度；5)最忌讳的写法（避免的AI腔）。250字以内。
【文章结构画像】包含：1)开头方式与钩子；2)正文如何分段落、分几部分、每部分讲什么；3)是否用小标题/列表/加粗；4)信息呈现顺序；5)结尾方式与CTA引导。250字以内。`;
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
    const raw = profile.trim();
    const splitIdx = raw.indexOf('【文章结构画像】');
    let structure = '';
    let style = raw;
    if (splitIdx > -1) {
      structure = raw.slice(splitIdx).replace(/^【文章结构画像】\s*/, '').trim();
      style = raw.slice(0, splitIdx).replace(/^【风格画像】\s*/, '').trim();
    }
    $('profileBox').value = style;
    lsSet(LS.profile, style);
    $('structureBox').value = structure;
    lsSet(LS.structure, structure);
    profileDirty = false;
  } catch {}
}

$('learnReset').onclick = () => {
  if (!confirm('确认清空所有学习素材、风格画像、海报学习记录与草稿？')) return;
  materials = [];
  drafts = [];
  localStorage.removeItem(LS.materials);
  localStorage.removeItem(LS.profile);
  localStorage.removeItem(LS.structure);
  localStorage.removeItem(LS.posterStyle);
  localStorage.removeItem(LS.drafts);
  $('profileBox').value = '';
  $('structureBox').value = '';
  profileDirty = true;
  renderLearnList();
  renderDraftCount();
  alert('已清空学习素材与画像。');
};

$('profileBox').value = lsGet(LS.profile, '');
$('profileBox').oninput = () => { lsSet(LS.profile, $('profileBox').value); profileDirty = false; };
$('structureBox').value = lsGet(LS.structure, '');
$('structureBox').oninput = () => { lsSet(LS.structure, $('structureBox').value); };
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
  '朋友圈': '输出3条朋友圈文案：每条以「朋友圈①」「朋友圈②」「朋友圈③」开头，默认每条150-250字（若用户明确指定字数则严格按用户字数执行），分2-3个短段落，有具体场景和小故事感，结尾一句自然引导，不硬广。只输出这3条文案本身，不要输出任何其他分析或说明。',
  '社群运营': '输出1条社群运营文案：默认150-200字（若用户明确指定字数则严格按用户字数执行），像真实运营者在群里自然说话，有活人感、允许口语化和语气词，结尾自然引导互动。只输出这条文案本身。',
  '小红书': '输出1篇完整小红书笔记：标题（带emoji、15字左右）+正文（默认600-1000字，若用户明确指定字数则严格按用户字数执行，真实体验感、分小节）+结尾5个话题标签。只输出笔记本身。',
  '公众号': '输出1篇公众号文章：10-20字标题、80字内导语、正文（默认1200-2000字，若用户明确指定字数则严格按用户字数执行，分小节）、结尾CTA。',
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
  const larkDocs = Array.isArray(knowledge.lark_docs) ? knowledge.lark_docs : [];
  if (larkDocs.length) {
    sections.push(`【飞书内容库（自动同步，内容以飞书文档为准，引用时优先采用）】\n${larkDocs.map(d =>
      `· ${d.name || d.key}（更新于 ${d.updated_at || '—'}）\n${String(d.text).slice(0, 9000)}`).join('\n\n')}`);
  }
  const helpDocs = Array.isArray(cat.help_docs) ? cat.help_docs : [];
  if (helpDocs.length) {
    sections.push(`【服务市场官方帮助文档（${catName}，引用时以文档为准）】\n${helpDocs.map(d =>
      `· ${d.title}：\n${String(d.text).slice(0, 2500)}`).join('\n\n')}`);
  }
  sections.push(`【当前知识库分类】${catName}：${cat.description || ''}${topics ? '（可参考主题：' + topics + '）' : ''}`);
  if (mp.official_site) sections.push(`【官方来源】${mp.official_site}——涉及平台规则以官方页面为准`);
  return sections.join('\n\n');
}

function buildSystemPrompt(payload) {
  return `你是携程酒店服务市场（Hmall）的资深内容运营，为酒店写真实、生动、可直接发布的中文内容。\n\n${KNOWLEDGE_STANCE}\n\n${knowledgeContext(payload)}`;
}

function buildTaskPrompt(payload) {
  const wantsCompare = /对比|比较|分析|竞品|哪个好|哪家好|品牌推荐|选型|区别|差异|怎么选/.test(String(payload.needs || '') + String(payload.product || '') + String(payload.content_type || ''));
  const needsText = String(payload.needs || '');
  const wordMatch = needsText.match(/(\d{2,4})\s*(?:字|字左右|字以内|字以上|字上下)/);
  const wordRequirement = wordMatch
    ? `\n\n【字数要求（最高优先级，覆盖渠道默认字数）】用户明确指定字数：${wordMatch[1]}字左右。必须严格按此字数输出，允许±10%偏差，宁缺毋滥不凑字。`
    : '';
  return `请为以下任务输出内容：
产品/主题：${payload.product}
目标视角：${payload.persona}
发布渠道/文章类型：${payload.channel}
内容类型：${payload.content_type}
生成需求（个性化要求，务必逐一满足，含字数要求）：${needsText || '无'}
联网研究：${payload.research || '无'}
文章风格样本：${String(payload.style_samples || '').slice(0, 12000)}
风格画像（AI学习总结，生成时严格遵循其语气、句式与结构习惯）：${String(payload.profile || '').slice(0, 6000)}
文章结构画像（AI从素材学习，生成时严格遵循其结构框架：开头钩子、段落组织、小标题/列表用法、信息顺序、结尾CTA）：${String(payload.structure || '').slice(0, 4000)}
用户学习素材摘要（提炼要点融入，不要照抄原文）：${String(payload.materials || '').slice(0, 8000)}

【输出格式（必须严格遵守，逐字执行）】
${CHANNEL_FORMATS[payload.channel] || '按其使用场景输出完整成稿。'}
${wordRequirement}

【硬性要求】
1. 直接输出正文，禁止以“好的”“以下是为您准备的”“根据您的需求”等开头。
2. 禁止复述或总结用户需求；禁止空话、套话、车轱辘话凑字数——字数以用户指令为准：用户明确指定字数时严格按指定字数，未指定时按渠道默认，宁短勿水。
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
    structure: $('structureBox').value,
    materials: checkedMaterialsText()
  };
  const deepThink = $('deepThink').checked;
  try {
    let content;
    if (hasByok()) {
      content = await openAILikeChat(
        buildSystemPrompt(payload),
        buildTaskPrompt(payload) + (deepThink ? '\n\n【深度思考要求】先系统梳理：受众与渠道特点、素材与知识库要点、可用的真实品牌/商品/价格数据、卖点优先级与结构方案；再输出成稿。推理过程不需要展示，直接给出最终内容。' : ''),
        { maxTokens: deepThink ? 9000 : 6500, deep: deepThink }
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
    lastCopy = content;
    lastCopyOriginal = content;
    $('copyEditBar').hidden = false;
    $('copyEditRevert').hidden = true;
    $('copyEditCmd').value = '';
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

/* AI 编辑已生成文案：按用户指令修改（不是手动修改） */
let lastCopy = '';
let lastCopyOriginal = '';

$('copyEditBtn').onclick = async () => {
  const cmd = $('copyEditCmd').value.trim();
  if (!lastCopy) return alert('请先生成文案');
  if (!cmd) return alert('先输入修改指令');
  const btn = $('copyEditBtn');
  btn.textContent = 'AI修改中…';
  btn.disabled = true;
  try {
    const system = '你是资深中文文案编辑。根据用户指令对原文进行修改：保留原文核心信息与平台立场，只按指令调整（语气、结构、字数、细节、卖点顺序等），不要复述指令，直接输出修改后的完整文案，不要加任何说明。';
    const user = `原文：\n${lastCopy}\n\n修改指令：${cmd}\n\n直接输出修改后的完整文案。`;
    let edited;
    if (hasByok()) {
      edited = await openAILikeChat(system, user, { maxTokens: 9000 });
    } else {
      if (IS_GITHUB_PAGES) await ensurePuterAuth();
      edited = await puterChat(system + '\n\n' + user);
    }
    $('result').textContent = edited;
    lastCopy = edited;
    $('copyEditRevert').hidden = false;
    $('copyEditCmd').value = '';
  } catch (error) {
    alert(`AI修改失败：${error.message}`);
  } finally {
    btn.textContent = '✏️ AI 修改';
    btn.disabled = false;
  }
};

$('copyEditRevert').onclick = () => {
  $('result').textContent = lastCopyOriginal;
  lastCopy = lastCopyOriginal;
  $('copyEditRevert').hidden = true;
  $('copyEditCmd').value = '';
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

/* 海报功能导航：点击导航块切换对应功能页 */
const posterNav = $('posterNav');
if (posterNav) {
  posterNav.querySelectorAll('button[data-view]').forEach(button => {
    button.onclick = () => {
      posterNav.querySelectorAll('button[data-view]').forEach(b => b.classList.remove('on'));
      button.classList.add('on');
      document.querySelectorAll('#poster .view').forEach(view => {
        view.hidden = view.dataset.view !== button.dataset.view;
      });
    };
  });
}

/* AI 成品海报：指令 + 参考图 → 一键生成成品海报 */

function parseInstructionSize(text) {
  const t = String(text || '');
  let m = t.match(/(\d{3,4})\s*[xX×*]\s*(\d{3,4})/);
  if (m) {
    const w = Math.min(4096, Math.max(200, +m[1]));
    const h = Math.min(4096, Math.max(200, +m[2]));
    return { w, h, ratio: w / h, label: w > h ? '横版' : (w < h ? '竖版' : '方形') };
  }
  m = t.match(/(\d+)\s*:\s*(\d+)/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    if (a > 0 && b > 0) return { ratio: a / b, label: a > b ? '横版' : (a < b ? '竖版' : '方形') };
  }
  if (/超长图|超长|长图|长条图/.test(t)) return { ratio: 1 / 2.2, label: '竖版长图' };
  if (/竖版|9:16|垂直|纵向/.test(t)) return { ratio: 9 / 16, label: '竖版' };
  if (/横版|16:9|水平|横向/.test(t)) return { ratio: 16 / 9, label: '横版' };
  if (/方形|正方|1:1/.test(t)) return { ratio: 1, label: '方形' };
  return null;
}

/* 按历史实际生成耗时动态预估进度条时长：第二次起进度条与实际等待时间基本同步 */
const imageGenDurations = [];

function estimateImageDuration() {
  if (!imageGenDurations.length) return 50000;
  const avg = imageGenDurations.reduce((a, b) => a + b, 0) / imageGenDurations.length;
  return Math.min(240000, Math.max(30000, Math.round(avg * 1.2)));
}

function recordImageDuration(ms) {
  imageGenDurations.push(ms);
  if (imageGenDurations.length > 5) imageGenDurations.shift();
}

/* 每张海报独立：生成结束后清空参考图（上传文件 + 知识库配图），
   避免上一次的参考图"残留记忆"影响下一次生成 */
function clearPosterRefs() {
  selectedKbImage = '';
  const ref = $('aiPosterRef');
  if (ref) ref.value = '';
  const grid = $('kbPosterImgs');
  if (grid) grid.querySelectorAll('.kb-img.on').forEach(el => el.classList.remove('on'));
}

/* 选好参考图后立即提示，避免"以为传了参考图其实没挂上" */
const aiPosterRefInput = $('aiPosterRef');
if (aiPosterRefInput) {
  aiPosterRefInput.addEventListener('change', () => {
    const file = aiPosterRefInput.files[0];
    const status = $('aiPosterStatus');
    if (status) status.textContent = file
      ? `已选择参考图：${file.name}（将严格按此图的版式/配色/风格生成）`
      : '';
  });
}

$('aiPosterBtn').onclick = async event => {
  const button = event.currentTarget;
  const t0 = Date.now();
  const progress = startProgress('aiPosterProgress', estimateImageDuration());
  const file = $('aiPosterRef').files[0];
  const cmd = $('aiPosterCmd').value.trim();
  const extraText = $('aiPosterText').value.trim();
  // 海报只使用海报区自己的输入（指令/补充文字/参考图），无风格下拉、无任何自动注入。
  // 不再自动带入主界面的产品/需求字段，避免"没写却生成相关内容"的乱生成。
  const instruction = cmd;
  const hasRef = !!file || !!selectedKbImage;
  let psize = posterSizeInfo();
  const instSize = parseInstructionSize(instruction);
  if (instSize) {
    if (instSize.w && instSize.h) {
      setPosterSize(instSize.w, instSize.h);
    } else if (instSize.ratio) {
      // 画布直接按成品尺寸来，避免出图后再缩放导致下载偏小
      const maxSide = instSize.ratio === 1 ? 1440 : 1920;
      const w = instSize.ratio >= 1 ? maxSide : Math.round(maxSide * instSize.ratio);
      const h = instSize.ratio >= 1 ? Math.round(maxSide / instSize.ratio) : maxSide;
      setPosterSize(w, h);
    }
    psize = posterSizeInfo();
  } else if (hasRef && !instSize) {
    // 有参考图且指令未指定尺寸：先按参考图本身比例定画布（参考图优先），再按文字量自动拉长
    const refSize = await referenceNaturalSize(file || selectedKbImage);
    if (refSize && refSize.w > 0 && refSize.h > 0) {
      const r = refSize.w / refSize.h;
      if (r >= 1) {
        setPosterSize(1920, Math.round(1920 / r));
      } else {
        setPosterSize(Math.round(1920 * r), 1920);
      }
    }
    const charCount = extraText.length + instruction.length;
    if (charCount > 350) {
      setPosterSize(Math.round(1920 * (1 / 2.2)), 1920); // 1:2.2 长图
    } else if (charCount > 180) {
      setPosterSize(Math.round(1920 * (9 / 16)), 1920); // 9:16 竖版
    }
    psize = posterSizeInfo();
  }
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const ratioText = `${psize.w / gcd(psize.w, psize.h)}:${psize.h / gcd(psize.w, psize.h)}`;
  const assetTextBlock = extraText
    ? `\n【需要排版展示的文字】必须完整放进画面，由你排版，一条都不能少、不能截断、不能改写：\n${extraText}`
    : '';
  let prompt;
  if (hasRef) {
    // 参考图优先模式：参考图是唯一设计基准，用户指令只描述替换/补充内容。
    // 不再附带任何可能与参考图冲突的约束（不预设配色、不禁止装饰元素等），
    // 避免模型收到矛盾指令后自由发挥出与参考图无关的海报。
    const lengthLine = extraText.length > 60
      ? '若文字较多，海报整体可沿参考图风格纵向自然延伸拉长，确保所有文字完整放下，延伸后仍是同一套版式与视觉语言。'
      : '';
    prompt = `请以这张参考图为基础，编辑生成一张成品海报。参考图是唯一的设计基准，必须完整保留、不得重新设计：
1. 完整保留参考图的构图、版式、配色、字体、标题位置、元素、装饰与整体氛围，逐一对齐，不要另起炉灶、不要自由发挥、不要擅自更换色调或改变版式；
2. 只按下面的用户要求替换/补充画面内容与文字，未提到的部分保持参考图原样；
3. 画面比例默认与参考图一致；用户明确要求的方向或比例优先。${lengthLine}
用户要求：${instruction || '按参考图原样输出，只做清晰化处理'}${assetTextBlock}
质量要求：中文文字准确、无错别字、无乱码；所有文字完整显示、不超出边缘、不被截断；画面铺满整张图，四周无白边、白框或留白；整体保持参考图的商业海报质感。`;
  } else {
    // 无参考图：纯文字生成，保留必要的防乱码/防白边约束
    prompt = `请生成一张${psize.label}${ratioText}的酒店营销海报成品图，输出比例严格为${ratioText}。
用户指令（请严格执行）：${instruction}${assetTextBlock}
硬性要求：画面铺满整张图，四周无白边、白框、留白或空隙；图片内中文文字准确、无错别字、无乱码；所有文字完整显示、不得超出边缘或被截断；标题醒目、卖点清晰、信息层级分明、商业海报质感。只呈现指令明确要求的内容：指令未提到的配色（尤其是橘金/香槟/金色系）、卡通动物贴纸、动物插画或装饰元素一律不得出现；若指令未指定配色，使用干净自然、贴合主题的配色，不预设任何固定色调。`;
  }
  const aspectKey = psize.ratio > 1.1 ? '16:9' : (psize.ratio < 0.9 ? '9:16' : 'square');
  const genOpts = {
    aspect: aspectKey,
    size: psize.api,
    onStatus: (s) => {
      const el = $('aiPosterStatus');
      if (el) el.textContent = `AI 生成中（${s}）…`;
    }
  };
  button.textContent = 'AI生成中…';
  const refNote = file ? '（附上传参考图）' : (selectedKbImage ? '（附知识库配图参考）' : '');
  $('aiPosterStatus').textContent = `正在按指令生成：${instruction.slice(0, 50)}${instruction.length > 50 ? '…' : ''}${refNote}`;
  let generatedOk = false;
  try {
    if (!hasByokImage()) {
      $('aiPosterStatus').textContent = imageConfigError();
      progress.stop();
      return;
    }
    if (!instruction) {
      progress.stop();
      $('aiPosterStatus').textContent = '请先在海报区填写生成指令（主界面的产品/需求不会自动带入海报）。';
      return;
    }
    let src;
    const imgCfg = getImageConfig();
    // 参考图优先：一旦带了参考图，就绝不降级成纯文字生成，
    // 否则模型会自由发挥出与参考图无关的海报。
    const refRefuse = '已停止生成，未降级为纯文字模式（避免产出与参考图无关的海报）；请检查图片服务商是否支持参考图编辑，或重新上传参考图后重试';
    if (selectedKbImage) {
      let kbDataUrl = '';
      try {
        const kbResp = await fetch(selectedKbImage);
        const kbBlob = await kbResp.blob();
        const kbFile = new File([kbBlob], 'kb.png', { type: kbBlob.type || 'image/png' });
        // 参考图压缩到 1280 并统一转 JPG：显著减小请求体积，降低中转超时概率
        const resized = await resizeImageFile(kbFile, 1280, { forceJpeg: true, quality: 0.85 });
        kbDataUrl = resized.dataUrl;
      } catch (kbError) {
        throw new Error(`知识库配图读取失败：${kbError.message}，请重新选择参考图后再试。`);
      }
      try {
        src = await openAILikeImage(prompt, { ...genOpts, reference: kbDataUrl, strictRef: true });
      } catch (refError) {
        throw new Error(`参考图生成失败：${refError.message}（${refRefuse}）`);
      }
    } else if (file) {
      let dataUrl = '';
      try {
        const resized = await resizeImageFile(file, 1280, { forceJpeg: true, quality: 0.85 });
        dataUrl = resized.dataUrl;
      } catch (fileError) {
        throw new Error(`参考图读取失败：${fileError.message}，请重新上传参考图后再试。`);
      }
      try {
        src = await openAILikeImage(prompt, { ...genOpts, reference: dataUrl, strictRef: true });
      } catch (refError) {
        throw new Error(`参考图生成失败：${refError.message}（${refRefuse}）`);
      }
    } else {
      src = await openAILikeImage(prompt, genOpts);
    }
    const image = new Image();
    image.src = src;
    await image.decode();
    // 生成图与画布比例不一致时自动匹配画布，避免 cover 裁剪截断文字
    const imgRatio = (image.naturalWidth || image.width) / (image.naturalHeight || image.height);
    const canvasRatio = canvas.width / canvas.height;
    if (Math.abs(imgRatio - canvasRatio) > 0.03) {
      if (canvas.width >= canvas.height) {
        setPosterSize(canvas.width, Math.round(canvas.width / imgRatio));
      } else {
        setPosterSize(Math.round(canvas.height * imgRatio), canvas.height);
      }
    }
    snapshot();
    backgroundImage = image;
    backgroundInfo = { mode: 'ai-poster' };
    objects = objects.filter(object => object.type !== 'text');
    selected = null;
    draw();
    renderLayers();
    savePosterHistory({
      type: 'ai-poster',
      instruction,
      prompt,
      engine: `${imgCfg.model}${hasRef ? '·参考图编辑' : ''}`,
      width: canvas.width,
      height: canvas.height,
      image: await posterHistoryImage(src)
    });
    generatedOk = true;
    progress.done();
    $('aiPosterStatus').textContent = hasRef
      ? `成品海报已生成（已按参考图编辑，引擎：${imgCfg.model}）。画布已更新为成品海报，可直接下载或微调。`
      : `成品海报已生成（本次为纯文字生成，未附参考图；若要参考图请先上传或点选知识库配图）。画布已更新为成品海报，可直接下载或微调。`;
  } catch (error) {
    $('aiPosterStatus').textContent = `生成失败：${error.message}`;
    progress.fail();
  } finally {
    recordImageDuration(Date.now() - t0);
    button.textContent = '🪄 AI 生成成品海报';
    // 生成成功才清空参考图，避免残留影响下一张；
    // 生成失败时保留参考图，方便用户检查配置后直接重试
    if (generatedOk) clearPosterRefs();
  }
};

/* 编辑 AI 海报：把当前画布海报作为参考图，按指令修改 */
$('aiEditBtn').onclick = async event => {
  const button = event.currentTarget;
  const t0 = Date.now();
  const progress = startProgress('aiEditProgress', estimateImageDuration());
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
    // 参考图压缩到 1280 以内：保证清晰度的同时降低中转体积与耗时，避免超出 Vercel 60s 上限
    const maxSide = 1280;
    const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
    const temp = document.createElement('canvas');
    temp.width = Math.round(canvas.width * scale);
    temp.height = Math.round(canvas.height * scale);
    temp.getContext('2d').drawImage(canvas, 0, 0, temp.width, temp.height);
    const reference = temp.toDataURL('image/jpeg', 0.92);
    const psize = posterSizeInfo();
    const aspectKey = psize.ratio > 1.1 ? '16:9' : (psize.ratio < 0.9 ? '9:16' : 'square');
    // AI 编辑完全 auto：尺寸/比例不写死在提示词里，由编辑指令和参考图共同决定；
    // 指令若要求改变方向、比例或尺寸（如"改成横版长图"），模型按指令调整，画布随后自动匹配
    const prompt = `请基于这张海报进行编辑，严格执行用户指令：${cmd}。指令未要求改动的部分保持与参考海报一致；若指令要求改变方向、比例或尺寸，则按指令调整；输出画面铺满整张图，四周无白边、白框、留白或空隙；中文文字准确、无错别字、无乱码，商业海报质感。`;
    const src = await openAILikeImage(prompt, { aspect: aspectKey, reference });
    const image = new Image();
    image.src = src;
    await image.decode();
    const imgRatio = (image.naturalWidth || image.width) / (image.naturalHeight || image.height);
    const canvasRatio = canvas.width / canvas.height;
    if (Math.abs(imgRatio - canvasRatio) > 0.03) {
      if (canvas.width >= canvas.height) {
        setPosterSize(canvas.width, Math.round(canvas.width / imgRatio));
      } else {
        setPosterSize(Math.round(canvas.height * imgRatio), canvas.height);
      }
    }
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
    recordImageDuration(Date.now() - t0);
    button.textContent = '✏️ 按指令编辑当前海报';
  }
};

/* ============================ 海报AI学习 ============================ */

function referenceNaturalSize(fileOrUrl) {
  return new Promise(resolve => {
    const img = new Image();
    let url = '';
    const finish = value => {
      if (url) URL.revokeObjectURL(url);
      resolve(value);
    };
    img.onload = () => finish({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });
    img.onerror = () => finish(null);
    if (typeof File !== 'undefined' && fileOrUrl instanceof File) {
      url = URL.createObjectURL(fileOrUrl);
      img.src = url;
    } else if (fileOrUrl) {
      img.src = fileOrUrl;
    } else {
      finish(null);
    }
    setTimeout(() => finish(null), 8000);
  });
}

function resizeImageFile(file, maxSide, { forceJpeg = false, quality = 0.9 } = {}) {
  return new Promise((resolve, reject) => {
    loadImageFile(file, image => {
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const width = Math.round(image.width * scale);
      const height = Math.round(image.height * scale);
      const temp = document.createElement('canvas');
      temp.width = width;
      temp.height = height;
      temp.getContext('2d').drawImage(image, 0, 0, width, height);
      const mime = forceJpeg ? 'image/jpeg' : (file.type.includes('png') ? 'image/png' : 'image/jpeg');
      resolve({ dataUrl: temp.toDataURL(mime, quality), mime });
    });
  });
}

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

/* ============================ 视频生成 ============================ */

/* 视频功能导航：三个功能页切换（限定在 #video 内，避免影响海报视图） */
const videoNav = $('videoNav');
if (videoNav) {
  videoNav.querySelectorAll('button[data-view]').forEach(button => {
    button.onclick = () => {
      videoNav.querySelectorAll('button[data-view]').forEach(b => b.classList.remove('on'));
      button.classList.add('on');
      document.querySelectorAll('#video .view').forEach(view => {
        view.hidden = view.dataset.view !== button.dataset.view;
      });
    };
  });
}

/* 视频任务专用慢速进度条：视频通常 1–5 分钟，别像文案那样几十秒就走完 */
function startVideoProgress(barId) {
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
    let step;
    if (progress < 30) step = 0.2 + Math.random() * 0.35;
    else if (progress < 70) step = 0.1 + Math.random() * 0.18;
    else if (progress < 90) step = 0.05 + Math.random() * 0.09;
    else step = 0.02;
    progress = Math.min(94, progress + step);
    pct.textContent = Math.floor(progress) + '%';
    fill.style.width = Math.floor(progress) + '%';
    timer = setTimeout(tick, 500);
  };
  timer = setTimeout(tick, 500);
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

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function videoConfigError() {
  if (!hasByokImage()) return imageConfigError();
  const imgCfg = getImageConfig();
  if (imgCfg.provider !== 'qianwen') {
    return '视频生成需要千问AI平台 Token Plan（阿里云月付套餐）：请在「AI 设置 → 图片生成」把图片服务商选为「千问AI平台 Token Plan（月付套餐）」，并填 sk-sp- 开头的 Key。';
  }
  return '';
}

async function relayVideoCreate(cfg, body) {
  if (!API_BASE) throw new Error('Token Plan 视频接口需要服务端中转，请在部署环境（github.io 线上页面）使用');
  const resp = await fetch(apiUrl('/api/token-plan-video-create'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ apiKey: cfg.key }, body))
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `视频任务创建失败（${resp.status}）`);
  if (!data.task_id) throw new Error('视频任务未返回任务 ID，请稍后重试');
  return data;
}

async function relayVideoGet(cfg, taskId) {
  if (!API_BASE) throw new Error('Token Plan 视频接口需要服务端中转，请在部署环境（github.io 线上页面）使用');
  const resp = await fetch(apiUrl('/api/token-plan-video-get'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: cfg.key, task_id: taskId })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `视频状态查询失败（${resp.status}）`);
  return data;
}

/* 轮询视频任务（每 15 秒一次，最长 10 分钟） */
async function pollVideoTask(cfg, taskId, statusEl) {
  const deadline = Date.now() + 10 * 60 * 1000;
  const labels = { PENDING: '排队中，请稍候…', RUNNING: '生成中，通常需要 1–5 分钟…' };
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 15000));
    const data = await relayVideoGet(cfg, taskId);
    if (statusEl && labels[data.task_status]) statusEl.textContent = labels[data.task_status];
    if (data.task_status === 'SUCCEEDED') return data;
    if (data.task_status === 'FAILED') throw new Error(data.message || '视频生成失败，请重试或调整指令');
  }
  throw new Error('视频生成超时（10 分钟），任务仍在后台运行，稍后可重试');
}

function showVideoPreview(url) {
  const box = $('videoPreviewBox');
  box.hidden = false;
  $('videoPreview').src = url;
  $('videoDownload').href = url;
}

function clearVideoPreview() {
  const video = $('videoPreview');
  video.pause();
  video.removeAttribute('src');
  video.load();
  $('videoPreviewBox').hidden = true;
}
if ($('videoPreviewClose')) $('videoPreviewClose').onclick = clearVideoPreview;

async function runVideoTask(kind, options, ui) {
  const progress = startVideoProgress(ui.progressId);
  const status = $(ui.statusId);
  const button = ui.button;
  status.textContent = '';
  const configError = videoConfigError();
  if (configError) {
    status.textContent = configError;
    progress.stop();
    return;
  }
  const cfg = getImageConfig();
  button.textContent = ui.busyLabel || '生成中…';
  try {
    const task = await relayVideoCreate(cfg, {
      kind,
      prompt: options.prompt || '',
      media: options.media || [],
      resolution: options.resolution || '720P',
      ratio: options.ratio || '',
      duration: options.duration || 5,
      sound_control: options.sound || ''
    });
    status.textContent = '任务已提交，排队中…';
    const result = await pollVideoTask(cfg, task.task_id, status);
    if (!result.video_url) throw new Error('任务完成但未返回视频地址，请稍后重试');
    showVideoPreview(result.video_url);
    status.textContent = '视频生成完成，已在上方预览，可点击下载。';
    progress.done();
  } catch (error) {
    status.textContent = `生成失败：${error.message}`;
    progress.fail();
  } finally {
    button.textContent = ui.idleLabel || '生成视频';
  }
}

function videoCommonParams(prefix) {
  const ratioEl = $(prefix + 'Ratio');
  const durationEl = $(prefix + 'Duration');
  return {
    resolution: $(prefix + 'Res').value,
    ratio: ratioEl ? ratioEl.value : '',
    duration: durationEl ? parseInt(durationEl.value, 10) : 5
  };
}

/* —— 图/文生视频 —— */
if ($('videoFirstFrame')) $('videoFirstFrame').onchange = async event => {
  const file = event.target.files && event.target.files[0];
  const box = $('videoFirstFramePreview');
  if (!file) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  try {
    const { dataUrl } = await resizeImageFile(file, 1024);
    box.innerHTML = `<img src="${dataUrl}" alt="首帧预览">`;
    box.hidden = false;
  } catch {
    box.hidden = true;
  }
};

if ($('videoT2vBtn')) $('videoT2vBtn').onclick = async event => {
  const button = event.currentTarget;
  let prompt = $('videoT2vPrompt').value.trim();
  const file = $('videoFirstFrame').files[0];
  const status = $('videoT2vStatus');
  let media = [];
  if (file) {
    try {
      const { dataUrl } = await resizeImageFile(file, 1024);
      media = [{ type: 'first_frame', url: dataUrl }];
    } catch {
      status.textContent = '首帧图片读取失败，请换一张图';
      return;
    }
  }
  if (!prompt && !media.length) {
    status.textContent = '请先输入视频描述（或上传首帧图片后只写运动描述）。';
    return;
  }
  const larkBg = larkRelevant(`${prompt} ${$('product').value || ''}`, 700, 1);
  if (larkBg) prompt += `\n\n【背景知识（仅作内容参考，不要朗读或把这些文字显示在画面里）】\n${larkBg}`;
  const kind = media.length ? 'i2v' : 't2v';
  await runVideoTask(kind, { prompt, media, ...videoCommonParams('videoT2v') }, {
    progressId: 'videoT2vProgress',
    statusId: 'videoT2vStatus',
    button,
    idleLabel: '🎬 生成视频',
    busyLabel: '生成中…'
  });
};

/* —— 参考生视频 —— */
const videoRefs = [];
function addVideoRef(src) {
  if (videoRefs.length >= 9) return;
  videoRefs.push(src);
  renderVideoRefs();
}
function removeVideoRef(index) {
  videoRefs.splice(index, 1);
  renderVideoRefs();
}
function renderVideoRefs() {
  const list = $('videoRefList');
  if (!list) return;
  if (!videoRefs.length) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = videoRefs.map((src, index) => `
    <div class="ref-thumb">
      <img src="${src}" alt="参考图 ${index + 1}">
      <span>${index + 1}</span>
      <button type="button" data-remove="${index}" title="删除">✕</button>
    </div>`).join('');
  list.querySelectorAll('[data-remove]').forEach(btn => {
    btn.onclick = () => removeVideoRef(+btn.dataset.remove);
  });
}

if ($('videoRefFiles')) $('videoRefFiles').onchange = async event => {
  const files = Array.from(event.target.files || []).slice(0, 9 - videoRefs.length);
  for (const file of files) {
    try {
      const { dataUrl } = await resizeImageFile(file, 1024);
      addVideoRef(dataUrl);
    } catch { /* 忽略损坏图片 */ }
  }
  event.target.value = '';
};

if ($('videoRefUrlBtn')) $('videoRefUrlBtn').onclick = async () => {
  const url = $('videoRefUrl').value.trim();
  if (!url) return alert('先粘贴链接');
  const btn = $('videoRefUrlBtn');
  const status = $('videoRefStatus');
  btn.textContent = '解析中…';
  status.textContent = '';
  try {
    const resp = await fetch(apiUrl('/api/token-plan-video-refs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `解析失败（${resp.status}）`);
    const images = (data.images || []).slice(0, 9 - videoRefs.length);
    if (!images.length) throw new Error('未提取到可用图片，请直接上传参考图');
    images.forEach(src => addVideoRef(src));
    status.textContent = `已从链接提取 ${images.length} 张参考图，可直接生成。`;
  } catch (error) {
    status.textContent = `链接解析失败：${error.message}`;
  } finally {
    btn.textContent = '解析链接';
  }
};

if ($('videoRefBtn')) $('videoRefBtn').onclick = async event => {
  const button = event.currentTarget;
  let prompt = $('videoRefPrompt').value.trim();
  const status = $('videoRefStatus');
  if (!prompt) {
    status.textContent = '请先输入视频描述（用 [Image 1]、[Image 2] 指代参考图）。';
    return;
  }
  if (!videoRefs.length) {
    status.textContent = '请先上传参考图或解析链接提取图片。';
    return;
  }
  const larkBg = larkRelevant(`${prompt} ${$('product').value || ''}`, 700, 1);
  if (larkBg) prompt += `\n\n【背景知识（仅作内容参考，不要朗读或把这些文字显示在画面里）】\n${larkBg}`;
  const media = videoRefs.map(url => ({ type: 'reference_image', url }));
  await runVideoTask('r2v', { prompt, media, ...videoCommonParams('videoRef') }, {
    progressId: 'videoRefProgress',
    statusId: 'videoRefStatus',
    button,
    idleLabel: '🖼 生成视频',
    busyLabel: '生成中…'
  });
};

/* —— 视频编辑 —— */
if ($('videoEditBtn')) $('videoEditBtn').onclick = async event => {
  const button = event.currentTarget;
  const prompt = $('videoEditPrompt').value.trim();
  const status = $('videoEditStatus');
  if (!prompt) {
    status.textContent = '请先输入编辑指令。';
    return;
  }
  const file = $('videoEditFile').files[0];
  const videoUrl = $('videoEditUrl').value.trim();
  if (!file && !videoUrl) {
    status.textContent = '请上传待编辑视频，或粘贴公网视频链接。';
    return;
  }
  if (file && file.size > 2.5 * 1024 * 1024) {
    status.textContent = '视频文件超过 2.5MB（中转接口限制），请压缩/截短后再上传，或粘贴公网视频链接。';
    return;
  }
  const media = [];
  try {
    if (file) media.push({ type: 'video', url: await readFileAsDataURL(file) });
    else media.push({ type: 'video', url: videoUrl });
    const refs = Array.from($('videoEditRefs').files || []).slice(0, 5);
    for (const ref of refs) {
      const { dataUrl } = await resizeImageFile(ref, 1024);
      media.push({ type: 'reference_image', url: dataUrl });
    }
  } catch {
    status.textContent = '文件读取失败，请重试。';
    return;
  }
  await runVideoTask('edit', {
    prompt,
    media,
    resolution: $('videoEditRes').value,
    sound: $('videoEditSound').value
  }, {
    progressId: 'videoEditProgress',
    statusId: 'videoEditStatus',
    button,
    idleLabel: '✂️ 编辑视频',
    busyLabel: '编辑中…'
  });
};

/* ============================ 初始化 ============================ */

updateHistoryButtons();
draw();
