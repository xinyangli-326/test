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
    "朋友圈": "朋友圈：输出3条180-350字长文案，像真人发的圈，有小故事感、场景感，不硬广。",
    "小红书": "小红书：完整种草或知识型成稿，含标题、正文、话题标签，真实体验感。",
    "公众号": "公众号：输出具体标题、导语、详细正文和CTA。",
    "销售话术": "销售话术：按真实沟通场景输出，含开场、需求挖掘、异议处理、促成动作。",
    "短视频口播": "短视频口播：脚本化，含钩子开场、节奏点、结尾引导，标注画面建议。",
    "内部提案": "内部提案：结构完整，含背景、方案、预算参考、风险与下一步。",
}


def generate(p):
    cat = KB["categories"].get(p.get("category"), {})
    channel = p.get("channel") or "朋友圈"
    needs = p.get("needs") or "无"
    profile = p.get("profile") or ""
    materials = p.get("materials") or ""
    prompt = f"""你是携程酒店服务市场的资深酒店营销专家，为酒店写真实、生动、可直接发布的中文内容。
知识库大类：{cat.get('name')}；定义：{cat.get('description')}；可参考主题：{cat.get('topics')}
产品/主题：{p.get('product')}
目标视角：{p.get('persona')}
发布渠道/文章类型：{channel}
内容类型：{p.get('content_type')}
生成需求（个性化要求，务必逐一满足）：{needs}
补充信息：{p.get('extra') or '无'}
联网研究：{p.get('research') or '无'}
文章风格样本：{str(p.get('style_samples') or '')[:12000]}
风格画像（AI学习总结，生成时严格遵循其语气、句式与结构习惯）：{str(profile)[:6000]}
用户学习素材摘要（提炼要点融入，不要照抄原文）：{str(materials)[:8000]}
渠道规则：{CHANNEL_RULES.get(channel, '按其使用场景输出完整成稿。')}
要求：
1. 具体回答覆盖人群、需求场景、痛点、产品价值、转化动作、指标和风险。
2. 遵循风格画像中的语气、句式与结构；没有画像时也避免AI腔，
   少用“值得注意的是”“综上所述”“在这个…的时代”等套话。
3. 若用户给出已有文案或细节要求（如调整细节、强调IP、强调功能、强调价格），
   先理解原意再改写，不丢失关键信息。
4. 内部数字写成参考值，不得编造平台规则。
输出：适用场景、核心钩子、完整正文、配图建议、CTA、风险提示。"""
    return chat(
        prompt,
        system="你是Trip MALL携程酒店服务市场的首席内容官，擅长把营销信息写成有人味的内容。",
        max_tokens=6500,
    )


def poster_copy(p):
    prompt = f"""为Trip MALL携程酒店服务市场生成一套竖版营销海报短文案。
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
