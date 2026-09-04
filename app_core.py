"""Trip MALL 营销知识库 - 核心业务逻辑（本地 server.py 与 Vercel api/index.py 共用）"""
import base64
import io
import ipaddress
import json
import os
import re
import zipfile
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
KB = json.loads((ROOT / "knowledge_base.json").read_text(encoding="utf-8-sig"))

PERSONAS = [
    "酒店老板", "店长", "业主", "总经理", "收益总监", "市场营销总监",
    "酒店营销人员", "酒店采购", "酒店经理", "销售总监", "前厅经理",
    "客房经理", "财务总监", "工程总监", "品牌总监", "投资人", "酒店顾问",
    "酒店供应商", "一线销售", "住客", "宠物主", "亲子家庭",
]

BANNED_IP = [
    "小黄人", "蛋仔派对", "迪士尼", "玲娜贝儿", "奥特曼",
    "宝可梦", "皮卡丘", "米老鼠", "星黛露", "库洛米",
]

STICKER_STYLES = {
    "卡通萌趣": "cute cartoon style, big expressive eyes, bold clean outline, playful",
    "写实风": "photorealistic style, natural lighting, soft shadows, detailed texture",
    "简洁风": "minimal flat design, simple shapes, generous negative space, clean",
    "3D立体": "soft 3D render style, glossy, rounded, subtle depth and lighting",
    "国潮插画": "Chinese trend illustration style, ink wash accents, elegant patterns",
    "手绘涂鸦": "hand-drawn doodle style, sketchy lines, casual, warm",
    "扁平极简": "flat vector style, solid colors, geometric, modern",
}

TOKEN_PLAN_BASE = "https://token-plan.cn-beijing.maas.aliyuncs.com"


def _token_plan_call(url, api_key, payload, timeout=60):
    import requests

    resp = requests.post(
        url,
        headers={
            "Authorization": "Bearer " + api_key,
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=timeout,
    )
    return resp


def _token_plan_error(resp, label):
    text = resp.text or ""
    try:
        err = resp.json()
        nested = err.get("error") if isinstance(err.get("error"), dict) else {}
        code = err.get("code") or nested.get("code") or nested.get("type") or ""
        message = err.get("message") or nested.get("message") or ""
        if code or message:
            text = f"{code} {message}".strip()
    except Exception:
        pass
    hint = ""
    if resp.status_code == 401:
        hint = (
            "（Token Plan 专属 Key 无效或订阅到期：请确认填的是 sk-sp- 开头 Key，"
            "且由本站中转固定调用 token-plan.cn-beijing.maas.aliyuncs.com）"
        )
    elif resp.status_code == 403:
        if "does not support asynchronous calls" in text:
            hint = "（当前 Token Plan 套餐不支持异步调用，服务端将自动改用同步模式）"
        else:
            hint = "（403：请检查当前套餐是否包含该模型，以及 Key 是否属于当前订阅）"
    elif resp.status_code == 429:
        hint = "（触发限流或套餐额度不足，请稍后重试）"
    return f"Token Plan {label}接口错误（{resp.status_code}）：{str(text)[:200]}{hint}"


def token_plan_chat(p):
    """Token Plan 文本中转：Token Plan 接口未开放浏览器跨域，必须服务端调用"""
    api_key = str(p.get("apiKey") or "").strip()
    if not api_key:
        raise ValueError("缺少 Token Plan API Key")
    messages = p.get("messages") or []
    model = str(p.get("model") or "qwen3.8-max").strip()
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": min(max(int(p.get("max_tokens") or 1800), 1), 2400),
        "temperature": float(p.get("temperature") or 0.85),
    }
    try:
        resp = _token_plan_call(
            TOKEN_PLAN_BASE + "/compatible-mode/v1/chat/completions",
            api_key,
            payload,
        )
    except Exception as error:
        if "Read timed out" in str(error) or "ReadTimeout" in type(error).__name__:
            raise TimeoutError(
                "Token Plan 文本生成超时：模型在 60 秒内未返回结果。已限制最大输出长度；请减少学习素材，或在 AI 设置中改用套餐内速度更快的 Flash/Plus 模型。"
            ) from error
        raise
    if resp.status_code != 200:
        raise RuntimeError(_token_plan_error(resp, "文本"))
    data = resp.json()
    content = ""
    choices = data.get("choices") or []
    if choices:
        content = choices[0].get("message", {}).get("content", "") or ""
    if not content:
        raise ValueError("Token Plan 返回内容为空")
    return {"content": content}


def _token_plan_image_result(data):
    out = data.get("output") or {}
    url = None
    if out.get("images"):
        url = out["images"][0].get("url") or None
    if out.get("results"):
        first_result = out["results"][0] or {}
        url = first_result.get("url") or first_result.get("image_url") or url
    for choice in out.get("choices") or []:
        message = choice.get("message") or {}
        parts = message.get("content") or []
        if isinstance(parts, list):
            for part in parts:
                if isinstance(part, dict) and part.get("image"):
                    url = part["image"]
                    break
        elif isinstance(parts, str) and (
            parts.startswith("https://") or parts.startswith("data:image")
        ):
            url = parts
    if not url:
        raise ValueError("Token Plan 图片接口未返回图片")
    if url.startswith("data:"):
        return {"image": url, "status": "SUCCEEDED"}
    import requests as _requests

    img_resp = _requests.get(url, timeout=60)
    img_resp.raise_for_status()
    return {
        "image": "data:image/png;base64," + base64.b64encode(img_resp.content).decode(),
        "status": "SUCCEEDED",
    }


def token_plan_image(p):
    """Token Plan 图片中转：异步创建任务并由浏览器轮询，避免长请求超时。"""
    import requests

    api_key = str(p.get("apiKey") or "").strip()
    if not api_key:
        raise ValueError("缺少 Token Plan API Key")
    task_id = str(p.get("taskId") or "").strip()
    headers = {
        "Authorization": "Bearer " + api_key,
        "Content-Type": "application/json",
    }
    if task_id:
        try:
            resp = requests.get(
                TOKEN_PLAN_BASE + "/api/v1/tasks/" + task_id,
                headers=headers,
                timeout=(10, 25),
            )
        except requests.RequestException as error:
            raise RuntimeError("Token Plan 图片任务查询失败，请稍后重试：" + str(error)) from error
        if resp.status_code != 200:
            raise RuntimeError(_token_plan_error(resp, "图片任务查询"))
        data = resp.json()
        output = data.get("output") or {}
        status = str(output.get("task_status") or data.get("task_status") or "UNKNOWN").upper()
        if status == "SUCCEEDED":
            return _token_plan_image_result(data)
        if status in {"FAILED", "CANCELED", "UNKNOWN"}:
            message = output.get("message") or data.get("message") or "图片任务未成功完成"
            raise RuntimeError(f"Token Plan 图片任务{status}：{message}")
        return {"taskId": task_id, "status": status}

    model = str(p.get("model") or "qwen-image-3.0-pro").strip()
    prompt = str(p.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("缺少图片描述")
    content = []
    reference = str(p.get("reference") or "")
    if reference.startswith("data:image"):
        content.append({"image": reference})
    content.append({"text": prompt})
    parameters = {"watermark": bool(p.get("watermark", False))}
    if p.get("prompt_extend"):
        parameters["prompt_extend"] = True
    size = str(p.get("size") or "").strip()
    if size:
        parameters["size"] = size
    payload = {
        "model": model,
        "input": {"messages": [{"role": "user", "content": content}]},
        "parameters": parameters,
    }
    headers["X-DashScope-Async"] = "enable"
    try:
        resp = requests.post(
            TOKEN_PLAN_BASE + "/api/v1/services/aigc/multimodal-generation/generation",
            headers=headers,
            json=payload,
            timeout=(10, 30),
        )
    except requests.RequestException as error:
        raise RuntimeError("Token Plan 图片任务创建失败，请稍后重试：" + str(error)) from error
    if resp.status_code == 403 and "does not support asynchronous calls" in (resp.text or ""):
        headers.pop("X-DashScope-Async", None)
        try:
            resp = requests.post(
                TOKEN_PLAN_BASE + "/api/v1/services/aigc/multimodal-generation/generation",
                headers=headers,
                json=payload,
                timeout=(10, 240),
            )
        except requests.ReadTimeout as error:
            raise TimeoutError("Token Plan Image 3.0 Pro 同步生成超过 240 秒，请重试；服务端已启用长任务时限。") from error
        except requests.RequestException as error:
            raise RuntimeError("Token Plan Image 3.0 Pro 同步生成失败：" + str(error)) from error
    if resp.status_code not in {200, 201, 202}:
        raise RuntimeError(_token_plan_error(resp, "图片任务创建"))
    data = resp.json()
    output = data.get("output") or {}
    task_id = str(output.get("task_id") or data.get("task_id") or "").strip()
    if not task_id:
        return _token_plan_image_result(data)
    return {
        "taskId": task_id,
        "status": str(output.get("task_status") or "PENDING").upper(),
    }

POSTER_STYLES = {
    "香槟金轻奢": "champagne gold and warm ivory luxury style, soft metallic accents, elegant, high-end hotel brand",
    "橙黑促销": "vibrant orange and deep charcoal promotional style, bold dynamic energy, modern retail campaign",
    "卡通萌趣": "cute playful flat illustration style, rounded friendly shapes, warm pastel colors",
    "数据案例": "clean professional data-driven style, subtle infographic motifs, refined business look",
    "清新简约": "fresh minimal style, soft tones, generous clean white space, airy and calm",
    "国潮中式": "Chinese heritage style, elegant ink-wash accents and auspicious motifs, refined and premium",
    "自然旅居": "natural resort style, greenery and wood textures, relaxed organic atmosphere",
}

POSTER_SCENES = {
    "大堂": "luxury hotel lobby with warm marble reception desk and soft chandelier light, spacious empty foreground",
    "客房": "elegant hotel guest room, neatly made bed with crisp linens, floor-to-ceiling window with city view, soft morning light",
    "亲子": "bright family-friendly hotel room, colorful kids corner with toys and safe cozy atmosphere",
    "宠物": "cozy pet-friendly hotel room, plush pet bed and feeding bowls on soft carpet, warm welcoming light",
    "餐厅": "stylish hotel restaurant with set table, coffee and breakfast, natural daylight",
    "露台泳池": "hotel terrace with pool and lounge chairs at golden hour, relaxed vacation mood",
    "城市夜景": "hotel room window at night with glittering city skyline, cozy warm interior light",
    "简约渐变": "refined minimal gradient background in brand colors, calm luxury atmosphere, no objects",
}


def require_key():
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("未设置 OPENAI_API_KEY，请先在 Vercel 环境变量中配置")
    return key


def get_client():
    from openai import OpenAI
    return OpenAI(api_key=require_key())


def strip_fence(text):
    cleaned = (text or "").strip()
    cleaned = cleaned.removeprefix("```json").removeprefix("```")
    cleaned = cleaned.removesuffix("```").strip()
    return cleaned


def chat(prompt, system=None, model=None, max_tokens=3500, temperature=0.85):
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    r = get_client().chat.completions.create(
        model=model or os.getenv("OPENAI_MODEL", "gpt-4o"),
        messages=messages,
        max_tokens=max_tokens,
        temperature=temperature,
    )
    return r.choices[0].message.content or ""


CHANNEL_RULES = {
    "社群运营": (
        "社群运营：150-200字左右，提炼内容精华，语气活泼、有“活人感”，"
        "像真实运营者在群里自然说话，允许口语化和少量语气词，"
        "结尾自然引导互动，不喊口号、不堆砌形容词。"
    ),
    "朋友圈": "朋友圈：输出3条，每条150-250字左右，像真人发的圈，有小故事感、场景感，不硬广。",
    "小红书": "小红书：完整种草或知识型成稿，含标题、正文、话题标签，真实体验感。",
    "公众号": "公众号：输出具体标题、导语、详细正文和CTA。",
    "销售话术": "销售话术：按真实沟通场景输出，含开场、需求挖掘、异议处理、促成动作。",
    "短视频口播": "短视频口播：脚本化，含钩子开场、节奏点、结尾引导，标注画面建议。",
    "内部提案": "内部提案：结构完整，含背景、方案、预算参考、风险与下一步。",
}

CHANNEL_FORMATS = {
    "朋友圈": "输出3条朋友圈文案：每条以「朋友圈①」「朋友圈②」「朋友圈③」开头，每条150-250字，分2-3个短段落，有具体场景和小故事感，结尾一句自然引导，不硬广。只输出这3条文案本身，不要输出任何其他分析或说明。",
    "社群运营": "输出1条社群运营文案：150-200字，像真实运营者在群里自然说话，有活人感、允许口语化和语气词，结尾自然引导互动。只输出这条文案本身。",
    "小红书": "输出1篇完整小红书笔记：标题（带emoji、15字左右）+正文（600-1000字，真实体验感、分小节）+结尾5个话题标签。只输出笔记本身。",
    "公众号": "输出1篇公众号文章：10-20字标题、80字内导语、1200-2000字正文（分小节）、结尾CTA。",
    "销售话术": "输出销售话术：按「开场→需求挖掘→异议处理→促成」的顺序，写成能直接对客户说出口的话，标注每一段的话术目的。",
    "短视频口播": "输出短视频口播脚本：开头钩子（3秒内）+正文3-5个节奏点+结尾引导，每句标注画面建议。",
    "内部提案": "输出内部提案：背景→方案→预算参考→风险→下一步，结构完整、可直接汇报。",
}


def _pet_room_context(product, channel=""):
    if not re.search(r"宠物|携宠", str(product or ""), re.I):
        return ""
    pet = KB.get("pet_room_data") or {}
    if not pet:
        return ""
    facts = "；".join(
        f"{item.get('metric')}：{item.get('value')}（{item.get('note', '')}）"
        for item in pet.get("market", {}).get("facts", [])
    )
    pains = "；".join(
        f"{item.get('name')}：{'、'.join(item.get('details', []))}"
        for item in pet.get("consumer_pain_points", [])
    )
    values = "；".join(
        pet.get("hotel_value", {}).get("revenue", [])
        + pet.get("hotel_value", {}).get("operation", [])
        + pet.get("hotel_value", {}).get("marketing", [])
    )
    solutions = "；".join(
        f"{item.get('name')}：{'、'.join(item.get('details', []))}"
        for item in pet.get("solution", {}).get("five_advantages", [])
    )
    psychology = "；".join(
        f"{role}：{'、'.join(points)}"
        for role, points in pet.get("customer", {}).get("hotel_decision_psychology", {}).items()
    )
    return "\n".join([
        "宠物友好房专项知识（优先使用）：",
        "方案定位：" + pet.get("positioning", {}).get("one_sentence", ""),
        "内容边界：" + pet.get("positioning", {}).get("content_boundary", ""),
        "市场依据：" + facts,
        "宠主痛点：" + pains,
        "酒店价值：" + values,
        "方案构成：" + solutions,
        "客户决策心理：" + psychology,
        "准入条件：" + "、".join(pet.get("eligibility", {}).get("required", [])),
        "不可改造：" + "、".join(pet.get("eligibility", {}).get("not_suitable", [])),
        "套餐区分：启航版=" + pet.get("packages", {}).get("starter", {}).get("price", "") + "，" + pet.get("packages", {}).get("starter", {}).get("scope_hint", "") + "；确认版=" + pet.get("packages", {}).get("confirmed", {}).get("scope_hint", ""),
        "三合一卖法：" + pet.get("product_architecture", {}).get("sales_translation", ""),
        "公众号参考文风：" + pet.get("style_profile", {}).get("positioning", "") + "；结构=" + "→".join(pet.get("style_profile", {}).get("structure", [])),
        "当前渠道文风适配：" + pet.get("style_profile", {}).get("channel_adaptation", {}).get(channel, ""),
        "BD表达逻辑：" + "；".join(pet.get("bd_messaging", {}).get("logic", [])),
        "禁止事项：" + "；".join(pet.get("bd_messaging", {}).get("avoid", []) + [item.get("rewrite", "") for item in pet.get("style_profile", {}).get("forbidden_or_rewrite", [])]),
        "数据合规：" + pet.get("roi", {}).get("usage_rule", "") + pet.get("compliance", {}).get("claims", ""),
    ])


def generate(p):
    cat = KB["categories"].get(p.get("category"), {})
    channel = p.get("channel") or "朋友圈"
    needs = p.get("needs") or "无"
    profile = p.get("profile") or ""
    materials = p.get("materials") or ""
    product_evidence = p.get("product_evidence") or ""
    is_product_recommendation_article = (
        p.get("category") == "product"
        and p.get("content_type") == "优品推荐"
        and channel == "公众号"
    )
    stance = (
        "平台立场（最高优先级，必须严格遵守）：你是携程酒店服务市场（Hmall）的内容运营。"
        "服务市场是酒店B2B一站式采购与服务平台：服务商/供应商把酒店经营所需的产品与服务"
        "（主题房方案、酒店用品、布草、设施、设计、旅拍、运营服务等）上架到服务市场，"
        "酒店客户在平台上浏览、比价、下单、支付与售后，采购成本可降低10%-30%。"
        "『上新』指产品/服务在服务市场上架，而不是酒店房型上新。"
        "所有内容必须站在服务市场/商家面向酒店客户的角度：讲清楚产品为酒店创造什么价值、"
        "为什么在服务市场采购更省心（放心、低价、一站式、售后支持）、如何登录服务市场了解或下单。"
        "不要把内容写成酒店经营者对住客的自我宣传（除非用户明确选择『酒店视角』）；"
        "涉及平台规则与官方表述，以携程酒店商家管理后台官网（ebooking.ctrip.com/hmall/index）"
        "及服务市场官方页面为准，不要凭空编造；联网搜索结果仅作事实与趋势参考，不要照搬其表述视角。"
    )
    product_brief = (
        "服务市场产品与优势速览（写内容时可引用）：平台精选客房用品、酒店布草、酒店设施、"
        "视觉设计、特色服务五大品类、上千个SKU；主题房改造（亲子房、宠物友好房、影音房、"
        "舒睡房等）是设计+物资配置+运营营销的一站式方案；官方六大服务保障：免房置换、低价保证、"
        "送货到店、快速开票、先行赔付、7天无理由退货；供应商-平台-酒店三步直达，集采成本可降低"
        "10%-30%（参考值）。"
    )
    mp = KB.get("marketplace", {})
    catalog_lines = [
        f"- {c.get('name')}：{c.get('desc')}（{'；'.join(c.get('examples', []))}）"
        for c in mp.get("catalog", {}).get("categories", [])
    ]
    adv = mp.get("advantages", {})
    kb_extra = "\n".join([
        "服务市场产品体系（写内容时按需引用）：",
        "\n".join(catalog_lines),
        f"官方六大服务保障：{adv.get('official_guarantees', '')}",
        "平台优势：" + "；".join(adv.get("platform_advantages", [])),
        _pet_room_context(p.get("product"), channel),
    ])
    recommendation_rules = ""
    if is_product_recommendation_article:
        evidence = product_evidence or "未匹配到商品ID对应详情：必须提示用户补充正确商品ID，不得编造商品卖点。"
        recommendation_rules = f"""
【产品类“优品推荐”公众号专用结构（最高优先级）】
{evidence}
1. 开头先给与商品直接相关的可核验数据或事实；没有统计数据时明确说明暂无可核验比例，严禁虚构百分比。
2. 按“问题/成因 → 已核验商品参数或功能 → 对酒店经营或住客体验的具体价值”逐项对应，没有证据的卖点不写。
3. 仅在证据中存在市场对比价时计算优惠金额或折扣；否则说明暂无可核验对比价，并使用已核验采购条件。
4. 结尾单列“为什么在携程服务市场采购”，引用平台知识库中的平台背书、丰富品类、一站式采购、品质与履约保障及多样支付方式。
5. 内容供服务市场BD转发给酒店客户，禁止写成酒店向住客宣传；标题和正文不得出现商品ID。
6. 无法核验的信息写“暂无可核验数据/以商品详情页为准”，不得编造。
"""
    prompt = f"""你是携程酒店服务市场的资深BD营销顾问，代表服务市场向酒店客户销售解决方案，产出供BD发布、转发或用于销售沟通的中文内容。
{stance}
{product_brief}
{kb_extra}
知识库大类：{cat.get('name')}；定义：{cat.get('description')}；可参考主题：{cat.get('topics')}
产品/主题：{p.get('product')}
目标客户角色（用于洞察经营压力、采购顾虑和决策动机，不是发文身份）：{p.get('persona')}
发布渠道/文章类型：{channel}
内容类型：{p.get('content_type')}
生成需求（个性化要求，务必逐一满足）：{needs}
联网研究：{p.get('research') or '无'}
文章风格样本：{str(p.get('style_samples') or '')[:12000]}
风格画像（AI学习总结，生成时严格遵循其语气、句式与结构习惯）：{str(profile)[:6000]}
用户学习素材摘要（提炼要点融入，不要照抄原文）：{str(materials)[:8000]}
{recommendation_rules}

【输出格式（必须严格遵守，逐字执行）】
{CHANNEL_FORMATS.get(channel, '按其使用场景输出完整成稿。')}

【硬性要求】
1. 直接输出正文，禁止以“好的”“以下是为您准备的”“根据您的需求”等开头。
2. 禁止复述或总结用户需求；禁止空话、套话、车轱辘话凑字数——字数宁短勿水，严格卡在格式要求范围内。
3. 站在服务市场/商家面向酒店客户的角度展开（除非用户明确要求酒店视角）。
4. 若用户给出已有文案或细节要求（调整细节、强调IP、强调功能、强调价格），先理解原意再改写，不丢失关键信息。
5. 内部数字写成参考值，不编造平台规则；避免“值得注意的是”“综上所述”“在这个…的时代”等AI腔。"""
    return chat(
        prompt,
        system="你是Trip MALL携程酒店服务市场的首席内容官，擅长把营销信息写成有人味的内容。",
        max_tokens=6500,
    )


def poster_copy(p):
    prompt = f"""为Trip MALL携程酒店服务市场生成一套竖版营销海报短文案。
平台立场：本海报用于宣传服务市场上新的产品/方案（如宠物友好房方案），
面向酒店客户（老板、店长、采购等），卖点是产品为酒店创造的价值+平台保障，
CTA引导登录服务市场查看详情或下单。可结合官方六大服务保障（免房置换、低价保证、
送货到店、快速开票、先行赔付、7天无理由退货）做卖点。不要写成酒店对住客的宣传。
产品/主题：{p.get('product')}；知识库：{p.get('category_name')}；
营销目标：{p.get('goal')}；目标视角：{p.get('persona')}。
只返回严格JSON，不要Markdown：
{{"eyebrow":"12字以内","headline":"14字以内","subheadline":"24字以内",
"price":"价格或核心利益，16字以内",
"features":["8字以内","8字以内","8字以内"],
"metrics":[{{"value":"短数字","label":"8字以内"}},
{{"value":"短数字","label":"8字以内"}},
{{"value":"短数字","label":"8字以内"}}],
"cta":"12字以内"}}
没有可靠数字时用“省心采购”“一站服务”等利益点，不编造数据。"""
    text = strip_fence(chat(prompt, max_tokens=1000))
    return json.loads(text)


def profile_summary(source):
    prompt = f"""你是资深中文文案编辑。从以下素材中提炼一份“风格画像”，
让之后只凭简短提示词就能生成同风格内容。
素材：
{str(source)[:20000]}
请输出中文风格画像，包含：1)整体语气；2)高频句式与开头方式；3)结构习惯；
4)常用词与口头禅；5)内容长度与信息密度；6)最忌讳的写法（避免的AI腔）。
400字以内，直接输出画像正文，不要Markdown标题。"""
    return chat(prompt, system="你是资深中文文案编辑。", max_tokens=1200, temperature=0.6)


def research(p):
    prompt = f"""联网研究酒店行业主题“{p.get('product')}”，
服务于携程酒店服务市场{p.get('category_name')}内容创作。
立场提示：服务市场是酒店B2B一站式采购平台，内容面向酒店客户，帮助服务市场上新的产品做宣传。
平台规则请优先核对官方来源：携程酒店商家管理后台（ebooking.ctrip.com/hmall/index）。
重点关注其品类体系（主题房改造、酒店用品/耗材、视觉设计、智能化设备、运营服务）与竞品差异。
查找最新公开趋势、目标人群、竞品内容、社媒高互动选题、采购或运营问题。
指定链接：{p.get('urls')}。受限链接必须说明无法读取，不能猜。
输出事实、来源、竞品启发和可执行选题，不复制原文。"""
    r = get_client().responses.create(
        model=os.getenv("OPENAI_RESEARCH_MODEL", os.getenv("OPENAI_MODEL", "gpt-4o")),
        tools=[{"type": "web_search_preview"}],
        input=prompt,
        max_output_tokens=3500,
    )
    return r.output_text


def image(prompt, size="1024x1024", transparent=False):
    r = get_client().images.generate(
        model=os.getenv("OPENAI_IMAGE_MODEL", "gpt-image-2"),
        prompt=prompt,
        size=size,
        quality=os.getenv("OPENAI_IMAGE_QUALITY", "high"),
        background="transparent" if transparent else "opaque",
    )
    return r.data[0].b64_json


def sticker(subject, style="卡通萌趣"):
    if any(name in subject for name in BANNED_IP):
        raise ValueError("商业IP贴纸请上传已获得授权的透明PNG素材；AI贴纸仅生成原创或通用角色。")
    style_desc = STICKER_STYLES.get(style, STICKER_STYLES["卡通萌趣"])
    prompt = f"""Create ONE single original sticker in {style_desc} style: {subject}.
The subject must be the only object, centered, full body, clear silhouette,
thick clean outline, expressive but tasteful pose, polished commercial sticker
cutout quality, soft natural lighting. Transparent background, no background
texture, no extra elements. No text, no letters, no logo, no watermark,
no deformed anatomy, no extra hands, no copyrighted character imitation."""
    return image(prompt, "1024x1024", transparent=True)


def poster(p):
    product = p.get("product", "酒店服务市场")
    style = p.get("style", "香槟金轻奢")
    scene = p.get("scene", "")
    desc = (p.get("description") or "").strip()
    elements = (p.get("elements") or "").strip()
    style_desc = POSTER_STYLES.get(style, POSTER_STYLES["香槟金轻奢"])
    scene_desc = POSTER_SCENES.get(scene, "") if scene else ""
    user_part = f" The main subject MUST be exactly: {desc}." if desc else ""
    motif_part = f" Include subtle supporting motifs related to: {elements}." if elements else ""
    scene_part = f" Scene: {scene_desc}." if scene_desc else " Scene: elegant premium hotel environment."
    prompt = (
        "Create a vertical 9:16 hotel marketing poster background as professional "
        "real-life commercial photography, not illustration, not abstract art.\n"
        f"Theme of the poster: {product}.\n"
        f"Style: {style_desc}.\n{scene_part}{user_part}{motif_part}\n"
        "Composition: one clear realistic subject, generous clean empty space in the "
        "center and lower third for headline text, soft realistic lighting, high "
        "dynamic range, sharp focus, premium Trip MALL brand palette (champagne gold "
        "#C39F77, warm ivory, dark coffee).\n"
        "MUST NOT contain: any text, letters, numbers, watermark, logo, people's faces, "
        "hands, deformed bodies, strange creatures, abstract floating shapes, collage, "
        "comic or cartoon style, overcrowded scenes. Keep it calm, realistic and premium."
    )
    return image(prompt, "1024x1536", transparent=False)


def poster_learn(p):
    data_b64 = p.get("data_b64", "")
    mime = p.get("mime", "image/png")
    if not data_b64:
        raise ValueError("缺少海报图片")
    data_url = f"data:{mime};base64,{data_b64}"
    prompt = """分析这张酒店营销海报，只返回JSON（不要Markdown）：
{
  "style_name": "一句话概括风格",
  "colors": ["#C39F77", "#FFFFFF"],
  "layout": "构图方式描述",
  "font_feel": "字体气质，如粗黑、衬线优雅、圆润可爱",
  "tone": "文案语气，如亲切、高级、促销感",
  "key_elements": ["核心视觉元素1", "核心视觉元素2"],
  "bg_prompt": "用于AI生成类似风格底图的英文描述，要求9:16竖版、无文字、无Logo、无版权角色",
  "layout_guide": "排版建议：标题/卖点/数据/CTA大致位置与配色"
}
不要猜测数据，不要复制海报上的任何具体文字内容。"""
    r = get_client().chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
        max_tokens=900,
    )
    return json.loads(strip_fence(r.choices[0].message.content))


def poster_edit(p):
    """真正的"图生图"：把参考海报喂给 Gemini 2.5 Flash Image（Nano Banana），
    生成同样风格的全新海报底图。"""
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("未配置 GOOGLE_API_KEY，无法使用AI模仿生成；已自动改用参考图直接作为底图")
    from google import genai
    from google.genai import types

    images = p.get("images") or [{
        "data_b64": p.get("data_b64", ""),
        "mime": p.get("mime", "image/png"),
    }]
    parts = []
    for image in images[:4]:
        data_b64 = image.get("data_b64", "")
        if not data_b64:
            continue
        parts.append(types.Part(inline_data=types.Blob(
            data=base64.b64decode(data_b64),
            mime_type=image.get("mime", "image/png"),
        )))
    if not parts:
        raise ValueError("缺少参考海报图片")

    product = p.get("product", "酒店服务市场")
    scene = p.get("scene", "")
    desc = (p.get("description") or "").strip()
    reference_count = len(parts)
    prompt = (
        f"参考下面{reference_count}张酒店营销海报的视觉风格（配色、构图、光影、设计语言、字体气质），"
        f"生成一张全新的 9:16 酒店营销海报底图，主题为「{product}」。"
    )
    if scene:
        prompt += f"画面场景：{scene}。"
    if desc:
        prompt += f"画面主体必须精确为：{desc}。"
    prompt += (
        "要求：整体气质和设计语言要明显接近参考海报，但画面内容必须是全新的；"
        "去掉所有文字、Logo、水印；主体清晰、居中偏下，上方和中央留出干净空白用于标题文案；"
        "真实商业摄影质感、柔和真实光线、高端酒店广告感；"
        "不要出现人脸特写、畸形肢体、奇怪生物、抽象漂浮物、拼贴、漫画风。"
    )

    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=os.getenv("GOOGLE_IMAGE_MODEL", "gemini-2.5-flash-image"),
        contents=types.Content(parts=parts + [types.Part(text=prompt)]),
        config=types.GenerateContentConfig(
            response_modalities=["TEXT", "IMAGE"],
            image_config=types.ImageConfig(aspect_ratio="9:16"),
        ),
    )
    for candidate in response.candidates:
        for part in candidate.content.parts:
            if part.inline_data and part.inline_data.data:
                return {
                    "image": "data:image/png;base64,"
                    + base64.b64encode(part.inline_data.data).decode(),
                }
    raise RuntimeError("AI 未返回图片，请稍后重试")


def _safe_fetch(url, timeout=20):
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("仅支持 http/https 链接")
    host = parsed.hostname or ""
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        addr = None
    if addr is not None and (addr.is_private or addr.is_loopback or addr.is_link_local):
        raise ValueError("不允许访问内网地址")
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
        ),
        "Accept": (
            "text/html,application/xhtml+xml,application/xml;q=0.9,"
            "text/plain;q=0.8,*/*;q=0.5"
        ),
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    try:
        import requests
        resp = requests.get(url, headers=headers, timeout=timeout, allow_redirects=True)
        resp.raise_for_status()
        return resp.content[:2_000_000], resp.headers.get("Content-Type", "")
    except ImportError:
        req = Request(url, headers=headers)
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read(2_000_000)
            ctype = resp.headers.get("Content-Type", "")
            if resp.headers.get("Content-Encoding", "").lower() == "gzip":
                import gzip
                raw = gzip.decompress(raw)
            return raw, ctype


def _decode_text(raw):
    for encoding in ("utf-8", "gb18030", "big5"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="ignore")


def _html_to_text(raw):
    text = _decode_text(raw)
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<!--.*?-->", " ", text, flags=re.S)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</(p|div|li|h[1-6]|tr)>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
    )
    text = re.sub(r"[ \t]{2,}", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _office_text(name, data):
    ext = Path(name).suffix.lower()
    if ext == ".pptx":
        with zipfile.ZipFile(data) as z:
            slides = sorted(
                (n for n in z.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
                key=lambda n: int(re.search(r"\d+", n).group()),
            )
            parts = []
            for n in slides:
                xml = z.read(n).decode("utf-8", errors="ignore")
                texts = re.findall(r"<a:t>(.*?)</a:t>", xml)
                parts.append("\n".join(t for t in texts if t.strip()))
            return "\n\n--- 下一页 ---\n\n".join(parts)
    if ext == ".docx":
        with zipfile.ZipFile(data) as z:
            xml = z.read("word/document.xml").decode("utf-8", errors="ignore")
        return "\n".join(t for t in re.findall(r"<w:t[^>]*>(.*?)</w:t>", xml) if t.strip())
    if ext == ".pdf":
        try:
            from pypdf import PdfReader
        except ImportError:
            raise ValueError("服务端缺少 pypdf 依赖，无法解析 PDF")
        reader = PdfReader(data)
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    return ""


def _plain_html(value):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", str(value or ""))).strip()


def product_detail(p):
    product_id = re.sub(r"\D", "", str(p.get("product_id") or ""))
    if not product_id:
        raise ValueError("缺少商品ID")
    cookie = os.environ.get("HMALL_COOKIE", "").strip()
    if not cookie:
        raise ValueError("Vercel 尚未配置 HMALL_COOKIE，无法读取登录后的服务市场商品详情")
    import requests
    response = requests.post(
        "https://ebooking.ctrip.com/hmall/api/product/getProduct",
        headers={
            "Content-Type": "application/json;charset=UTF-8",
            "Accept": "application/json, text/plain, */*",
            "Referer": f"https://ebooking.ctrip.com/hmall/product/detail/{product_id}",
            "Cookie": cookie,
            "User-Agent": "Mozilla/5.0",
        },
        json={"productId": product_id},
        timeout=30,
    )
    if "text/html" in response.headers.get("content-type", "").lower():
        raise ValueError("HMALL_COOKIE 已失效，服务市场返回登录页，请更新 Vercel 环境变量")
    response.raise_for_status()
    body = response.json()
    data = body.get("data") if isinstance(body, dict) else None
    if not data:
        raise ValueError((body or {}).get("message") or "商品详情接口未返回数据")
    detail_html = str(data.get("detail") or "")
    detail_images = []
    for image_url in re.findall(r"<img[^>]+src=[\'\"]([^\'\"]+)[\'\"]", detail_html, re.I):
        if image_url.startswith("//"):
            image_url = "https:" + image_url
        if image_url.startswith("https://") and image_url not in detail_images:
            detail_images.append(image_url)
    packages = []
    for item in data.get("packages") or []:
        packages.append({
            "name": item.get("name"),
            "price": item.get("price"),
            "original_price": item.get("originPrice"),
            "coupon_price": item.get("couponPrice"),
            "min_qty": item.get("minQuantity"),
            "properties": [x.get("propertyValue") or x.get("value") or str(x) for x in (item.get("packagePropertyList") or [])],
        })
    return {
        "id": product_id,
        "name": data.get("name"),
        "subtitle": data.get("subtitle"),
        "summary": _plain_html(data.get("summary")),
        "detail": _plain_html(detail_html)[:12000],
        "detail_images": detail_images[:20],
        "supplier": (data.get("supplier") or {}).get("supplierName"),
        "packages": packages,
        "delivery": {"source": data.get("sourceAddress"), "freight": data.get("freightInfo")},
        "guarantees": {
            "seven_day_return": data.get("enableSevenDayReturn"),
            "trial": data.get("trial"),
        },
    }


def extract(p):
    url = p.get("url") or ""
    if url:
        raw, ctype = _safe_fetch(url)
        lower = ctype.lower()
        if "pdf" in lower:
            content = _office_text("upload.pdf", raw)
        elif "html" in lower or lower.startswith("text/") or b"<" in raw[:500]:
            content = _html_to_text(raw)
        elif "json" in lower:
            content = _decode_text(raw)
        else:
            content = _html_to_text(raw)
        if not content.strip():
            raise ValueError("网页内容为空，可能需要登录或动态渲染，请复制正文粘贴到风格样本")
        return {"content": content[:30000], "name": url, "type": "url"}

    name = p.get("filename", "upload.txt")
    data = base64.b64decode(p.get("data_b64", ""))
    stream = io.BytesIO(data)
    ext = Path(name).suffix.lower()
    if ext in (".txt", ".md", ".csv", ".json"):
        content = _decode_text(data)
    elif ext in (".html", ".htm"):
        content = _html_to_text(data)
    elif ext in (".pptx", ".docx", ".pdf"):
        content = _office_text(name, stream)
    else:
        raise ValueError("暂不支持该文件类型，支持：txt/md/docx/pptx/pdf/html")
    if not content.strip():
        raise ValueError("未能从文件中提取到文本")
    return {"content": content[:30000], "name": name, "type": ext.lstrip(".")}
