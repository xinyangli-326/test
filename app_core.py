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


def _token_plan_call(url, api_key, payload, timeout=90, headers=None):
    import requests

    req_headers = {
        "Authorization": "Bearer " + api_key,
        "Content-Type": "application/json",
    }
    if headers:
        req_headers.update(headers)
    resp = requests.post(
        url,
        headers=req_headers,
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
    # 脱敏：抹掉错误信息里可能回显的 Key 片段
    import re as _re
    text = _re.sub(r"\b(sk-[A-Za-z0-9_-]{12,}|sk-sp-[A-Za-z0-9_-]{12,}|sk-ws-[A-Za-z0-9_-]{12,}|LTAI[A-Za-z0-9]{16,})\b",
                   lambda m: m.group(1)[:4] + "…" + m.group(1)[-4:], text)
    hint = ""
    if resp.status_code == 401:
        hint = (
            "（Token Plan 专属 Key 无效或订阅到期：请确认填的是 sk-sp- 开头 Key，"
            "且由本站中转固定调用 token-plan.cn-beijing.maas.aliyuncs.com）"
        )
    elif resp.status_code == 403:
        hint = (
            "（403：该模型不在你的 Token Plan 套餐版本内，"
            "请换 qwen-image-2.0-pro / wan2.7-image 等套餐内模型）"
        )
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
        "max_tokens": int(p.get("max_tokens") or 3000),
        "temperature": float(p.get("temperature") or 0.85),
    }
    resp = _token_plan_call(
        TOKEN_PLAN_BASE + "/compatible-mode/v1/chat/completions",
        api_key,
        payload,
    )
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


def _image_content(p, prompt):
    """从请求里取 1-3 张参考图（references 数组，兼容旧 reference）构造多模态消息内容"""
    content = []
    refs = p.get("references")
    if isinstance(refs, str):
        refs = [refs]
    if not isinstance(refs, list):
        refs = []
    seen = []
    for r in refs[:3]:
        r = str(r or "")
        if r.startswith("data:image") and r not in seen:
            content.append({"image": r})
            seen.append(r)
    single = str(p.get("reference") or "")
    if single.startswith("data:image") and single not in seen:
        content.append({"image": single})
        seen.append(single)
    content.append({"text": prompt})
    return content


def token_plan_image(p):
    """Token Plan 图片中转：走官方多模态接口，图片下载后转 base64 返回"""
    api_key = str(p.get("apiKey") or "").strip()
    if not api_key:
        raise ValueError("缺少 Token Plan API Key")
    model = str(p.get("model") or "qwen-image-3.0-pro").strip()
    prompt = str(p.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("缺少图片描述")
    content = _image_content(p, prompt)
    parameters = {"watermark": False}
    if "prompt_extend" in p:
        # 显式透传 true/false：前端关闭 prompt 改写（防止文字乱码）时，后端不能把 false 吞掉
        parameters["prompt_extend"] = bool(p.get("prompt_extend"))
    size = str(p.get("size") or "").strip()
    if size:
        parameters["size"] = size
    negative_prompt = str(p.get("negative_prompt") or "").strip()
    if negative_prompt:
        parameters["negative_prompt"] = negative_prompt
    payload = {
        "model": model,
        "input": {"messages": [{"role": "user", "content": content}]},
        "parameters": parameters,
    }
    url = TOKEN_PLAN_BASE + "/api/v1/services/aigc/multimodal-generation/generation"
    # 注意：Vercel Hobby 函数上限 60s，超过会被直接掐断；不在此处重试，避免慢速成功时重复扣费
    resp = _token_plan_call(url, api_key, payload, timeout=175)
    if resp.status_code != 200:
        raise RuntimeError(_token_plan_error(resp, "图片"))
    data = resp.json()
    out = data.get("output") or {}
    url = None
    if out.get("images"):
        url = out["images"][0].get("url") or None
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
        return {"image": url}
    import requests as _requests

    img_resp = _requests.get(url, timeout=60)
    img_resp.raise_for_status()
    return {
        "image": "data:image/png;base64," + base64.b64encode(img_resp.content).decode()
    }


def token_plan_image_async(p):
    """Token Plan 图片异步提交：立即返回 task_id，不阻塞等待。
    生图耗时长（尤其参考图编辑），同步中转会被 Vercel 函数 60s 上限掐断，
    改用异步任务制后，中转函数只负责快速提交与轻量轮询，彻底绕开 60s 限制。"""
    api_key = str(p.get("apiKey") or "").strip()
    if not api_key:
        raise ValueError("缺少 Token Plan API Key")
    model = str(p.get("model") or "qwen-image-3.0-pro").strip()
    prompt = str(p.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("缺少图片描述")
    content = _image_content(p, prompt)
    parameters = {"watermark": False}
    if "prompt_extend" in p:
        parameters["prompt_extend"] = bool(p.get("prompt_extend"))
    size = str(p.get("size") or "").strip()
    if size:
        parameters["size"] = size
    negative_prompt = str(p.get("negative_prompt") or "").strip()
    if negative_prompt:
        parameters["negative_prompt"] = negative_prompt
    payload = {
        "model": model,
        "input": {"messages": [{"role": "user", "content": content}]},
        "parameters": parameters,
    }
    resp = _token_plan_call(
        TOKEN_PLAN_BASE + "/api/v1/services/aigc/image-generation/generation",
        api_key,
        payload,
        timeout=30,
        headers={"X-DashScope-Async": "enable"},
    )
    if resp.status_code != 200:
        raise RuntimeError(_token_plan_error(resp, "图片"))
    data = resp.json()
    out = data.get("output") or {}
    task_id = out.get("task_id") or data.get("task_id") or ""
    if not task_id:
        raise ValueError("Token Plan 图片异步接口未返回 task_id：" + str(data)[:200])
    return {"task_id": task_id, "task_status": out.get("task_status") or "PENDING"}


def token_plan_image_task(p):
    """Token Plan 图片任务轮询中转：GET /tasks/{task_id}"""
    api_key = str(p.get("apiKey") or "").strip()
    task_id = str(p.get("task_id") or "").strip()
    if not api_key:
        raise ValueError("缺少 Token Plan API Key")
    if not task_id:
        raise ValueError("缺少图片任务 ID")
    resp = _token_plan_get(
        TOKEN_PLAN_BASE + "/api/v1/tasks/" + task_id,
        api_key,
        timeout=30,
    )
    if resp.status_code != 200:
        raise RuntimeError(_token_plan_error(resp, "图片"))
    data = resp.json()
    out = data.get("output") or {}
    task_status = str(out.get("task_status") or data.get("task_status") or "RUNNING").upper()
    image_url = ""
    results = out.get("results")
    if isinstance(results, list):
        for item in results:
            if isinstance(item, dict):
                image_url = str(item.get("url") or item.get("image") or "")
                if image_url:
                    break
    if not image_url and isinstance(out.get("images"), list):
        for item in out["images"]:
            if isinstance(item, dict):
                image_url = str(item.get("url") or "")
                if image_url:
                    break
    if not image_url:
        image_url = str(out.get("image_url") or out.get("image") or "")
    result = {"task_id": task_id, "task_status": task_status, "image_url": image_url}
    message = out.get("message") or out.get("error") or data.get("message") or ""
    if message:
        result["message"] = str(message)[:500]
    return result


def _token_plan_get(url, api_key, timeout=30):
    import requests

    resp = requests.get(
        url,
        headers={"Authorization": "Bearer " + api_key},
        timeout=timeout,
    )
    return resp


VIDEO_MODELS = {
    "t2v": "happyhorse-1.1-t2v",
    "i2v": "happyhorse-1.1-i2v",
    "r2v": "happyhorse-1.1-r2v",
    "edit": "happyhorse-1.0-video-edit",
}


def token_plan_video_create(p):
    """Token Plan 视频中转：异步提交任务。
    kind: t2v 文生视频 / i2v 图生视频(首帧) / r2v 参考生视频 / edit 视频编辑。
    Token Plan 接口未开放浏览器跨域，必须由服务端调用。
    """
    api_key = str(p.get("apiKey") or "").strip()
    if not api_key:
        raise ValueError("缺少 Token Plan API Key")
    kind = str(p.get("kind") or "t2v").strip()
    model = VIDEO_MODELS.get(kind)
    if not model:
        raise ValueError("不支持的视频类型：" + kind)
    prompt = str(p.get("prompt") or "").strip()
    media = p.get("media") or []
    clean_media = []
    for item in media:
        if isinstance(item, dict) and item.get("url"):
            clean_media.append(
                {
                    "type": str(item.get("type") or "reference_image"),
                    "url": str(item["url"]),
                }
            )
    if kind in ("t2v", "r2v", "edit") and not prompt:
        raise ValueError("缺少视频描述/编辑指令")
    if kind == "i2v" and not clean_media:
        raise ValueError("图生视频需要上传首帧图片")
    if kind == "r2v" and not clean_media:
        raise ValueError("参考生视频需要至少一张参考图")
    if kind == "edit" and not any(m.get("type") == "video" for m in clean_media):
        raise ValueError("视频编辑需要上传或粘贴待编辑视频")
    video_input = {}
    if prompt:
        video_input["prompt"] = prompt
    if clean_media:
        video_input["media"] = clean_media
    parameters = {"watermark": False}
    resolution = str(p.get("resolution") or "720P").strip()
    if resolution:
        parameters["resolution"] = resolution
    ratio = str(p.get("ratio") or "").strip()
    if ratio and kind in ("t2v", "r2v"):
        parameters["ratio"] = ratio
    duration = p.get("duration")
    if duration and kind in ("t2v", "i2v", "r2v"):
        try:
            parameters["duration"] = int(duration)
        except (TypeError, ValueError):
            pass
    sound = str(p.get("sound_control") or "").strip()
    if sound and kind == "edit":
        parameters["sound_control"] = sound
    payload = {"model": model, "input": video_input, "parameters": parameters}
    resp = _token_plan_call(
        TOKEN_PLAN_BASE + "/api/v1/services/aigc/video-generation/video-synthesis",
        api_key,
        payload,
        timeout=60,
    )
    if resp.status_code != 200:
        raise RuntimeError(_token_plan_error(resp, "视频"))
    data = resp.json()
    out = data.get("output") or {}
    task_id = out.get("task_id") or ""
    if not task_id:
        raise ValueError("Token Plan 视频接口未返回 task_id")
    return {"task_id": task_id, "task_status": out.get("task_status") or "PENDING"}


def token_plan_video_get(p):
    """Token Plan 视频轮询中转：GET /tasks/{task_id}"""
    api_key = str(p.get("apiKey") or "").strip()
    task_id = str(p.get("task_id") or "").strip()
    if not api_key:
        raise ValueError("缺少 Token Plan API Key")
    if not task_id:
        raise ValueError("缺少视频任务 ID")
    resp = _token_plan_get(
        TOKEN_PLAN_BASE + "/api/v1/tasks/" + task_id,
        api_key,
        timeout=30,
    )
    if resp.status_code != 200:
        raise RuntimeError(_token_plan_error(resp, "视频"))
    data = resp.json()
    out = data.get("output") or {}
    result = {
        "task_id": task_id,
        "task_status": out.get("task_status") or "RUNNING",
        "video_url": out.get("video_url") or "",
    }
    message = out.get("message") or out.get("error") or data.get("message") or ""
    if message:
        result["message"] = str(message)[:500]
    return result


def token_plan_video_refs(p):
    """参考生视频：从外部链接提取页面图片，返回公网 URL 列表作为参考图"""
    url = str(p.get("url") or "").strip()
    if not url:
        raise ValueError("缺少链接")
    raw, _ctype = _safe_fetch(url, timeout=20)
    text = _decode_text(raw)
    page = urlparse(url)
    scheme = page.scheme or "https"
    host = page.netloc or ""

    def abs_url(ref):
        ref = ref.strip().strip('"').strip("'")
        if not ref or ref.lower().startswith("data:"):
            return ""
        if ref.startswith("//"):
            return scheme + ":" + ref
        if ref.startswith(("http://", "https://")):
            return ref
        if ref.startswith("/"):
            return scheme + "://" + host + ref
        return scheme + "://" + host + "/" + ref

    candidates = []
    for m in re.finditer(
        r'<meta[^>]+(?:og:image|twitter:image)[^>]+>', text, re.I
    ):
        cm = re.search(r'content=["\']([^"\']+)["\']', m.group(0), re.I)
        if cm:
            candidates.append(cm.group(1))
    for m in re.finditer(r'<img[^>]+src=["\']([^"\']+)["\']', text, re.I):
        candidates.append(m.group(1))
    for m in re.finditer(r'(?:<img[^>]+|<source[^>]+)srcset=["\']([^"\']+)["\']', text, re.I):
        first = m.group(1).split(",")[0].strip().split(" ")[0]
        candidates.append(first)
    for m in re.finditer(r'background-image\s*:\s*url\(["\']?([^"\')\s]+)', text, re.I):
        candidates.append(m.group(1))
    for attr in ("data-src", "data-original", "data-lazy-src", "data-echo", "data-url"):
        for m in re.finditer(attr + r'=["\']([^"\']+)["\']', text, re.I):
            candidates.append(m.group(1))
    bad_tokens = (
        "logo",
        "icon",
        "sprite",
        "loading",
        "placeholder",
        "pixel",
        "blank",
        "avatar",
        "spinner",
        "1x1",
    )
    seen, images = set(), []
    for ref in candidates:
        abs_url_value = abs_url(ref)
        if not abs_url_value or abs_url_value in seen:
            continue
        lower = abs_url_value.lower()
        if any(token in lower for token in bad_tokens):
            continue
        if not lower.endswith((".jpg", ".jpeg", ".png", ".webp", ".gif")):
            continue
        seen.add(abs_url_value)
        images.append(abs_url_value)
        if len(images) >= 9:
            break
    if not images:
        raise ValueError("未从该链接提取到可用图片，请直接上传参考图")
    return {"images": images}


LARK_AUTH_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
LARK_DOC_META = "https://open.feishu.cn/open-apis/docx/v1/documents/{doc_id}"
LARK_DOC_RAW = "https://open.feishu.cn/open-apis/docx/v1/documents/{doc_id}/raw_content"


def _lark_tenant_token(app_id, app_secret):
    import requests

    resp = requests.post(
        LARK_AUTH_URL,
        json={"app_id": app_id, "app_secret": app_secret},
        timeout=15,
    )
    data = resp.json()
    if resp.status_code != 200 or data.get("code") not in (0, None):
        msg = data.get("msg") or str(data)[:200]
        raise RuntimeError("飞书应用鉴权失败：" + str(msg))
    token = data.get("tenant_access_token")
    if not token:
        raise RuntimeError("飞书应用鉴权未返回 token")
    return token


def _lark_time(value):
    from datetime import datetime, timezone, timedelta

    try:
        return datetime.fromtimestamp(int(value) / 1000, tz=timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return str(value or "")


def _cn_now():
    from datetime import datetime, timezone, timedelta

    return datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")


def _lark_public_content(html):
    """从公开飞书文档 HTML 尽力提取正文。"""
    m = re.search(r'"(?:content|text|body)"\s*:\s*"((?:[^"\\]|\\.){20,})"', html)
    if m:
        try:
            return m.group(1).encode("latin1", errors="ignore").decode("unicode_escape", errors="ignore")
        except Exception:
            return m.group(1)
    return _html_to_text(html.encode("utf-8", errors="ignore"))


def _lark_docx_parse(html):
    """解析公开飞书文档（docx）页面内嵌的 window.DATA → 还原正文与附件列表。
    返回 {"text": ..., "files": [{"token","name","mimeType","size"}], "title": ...}
    """
    marker = "window.DATA = Object.assign({}, window.DATA, { clientVars: Object("
    idx = html.find(marker)
    if idx < 0:
        # 兼容其他挂载形式
        m2 = re.search(r"clientVars:\s*Object\((\{)", html)
        if not m2:
            return None
        seg = html[m2.start(1):]
    else:
        seg = html[idx + len(marker):]  # 从 clientVars 的 { 开始
    depth = 0
    end = 0
    for i, ch in enumerate(seg):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if not end:
        return None
    try:
        cv = json.loads(seg[:end])
    except Exception:
        return None
    data = cv.get("data") or {}
    block_map = data.get("block_map") or {}
    sequence = data.get("block_sequence") or []
    seq_index = {bid: i for i, bid in enumerate(sequence)}

    def children_of(bid):
        kids = [b for b in block_map.values() if b.get("parent_id") == bid]
        kids.sort(key=lambda b: seq_index.get(b.get("id"), 99999))
        return kids

    def block_text(bid):
        b = block_map.get(bid) or {}
        dd = b.get("data") or {}
        parts = []
        if dd.get("type") == "text":
            it = (dd.get("text") or {}).get("initialAttributedTexts") or {}
            tm = it.get("text") or {}
            parts.append("".join(v for _, v in sorted(tm.items(), key=lambda kv: int(kv[0]))))
        for c in children_of(bid):
            parts.append(block_text(c.get("id")))
        for cid in dd.get("children") or []:
            parts.append(block_text(cid))
        return "".join(parts).strip()

    # 从 page 根块递归构建文档结构（段落 + 表格）
    def render_block(bid):
        b = block_map.get(bid) or {}
        dd = b.get("data") or {}
        btype = dd.get("type")
        out = []
        if btype == "text":
            t = block_text(bid)
            if t:
                out.append(t)
        elif btype == "table":
            cols = dd.get("columns_id") or []
            rows_ids = dd.get("rows_id") or []
            cell_set = dd.get("cell_set") or {}
            for rid in rows_ids:
                cells = []
                for cid in cols:
                    rid_clean = rid[3:] if rid.startswith("row") else rid
                    cid_clean = cid[3:] if cid.startswith("col") else cid
                    info = cell_set.get("row" + rid_clean + "col" + cid_clean) or {}
                    cells.append(block_text(info.get("block_id") or ""))
                out.append(" | ".join(cells))
        for cid in dd.get("children") or []:
            out.extend(render_block(cid))
        return out

    lines = []
    for bid in sequence:
        b = block_map.get(bid) or {}
        if (b.get("data") or {}).get("type") == "page":
            lines = render_block(bid)
            break
    files = []
    for b in block_map.values():
        dd = b.get("data") or {}
        if dd.get("type") == "file":
            f = dd.get("file") or {}
            if f.get("token"):
                files.append(
                    {
                        "token": f["token"],
                        "name": f.get("name") or "",
                        "mimeType": f.get("mimeType") or "",
                        "size": f.get("size") or 0,
                    }
                )
    text = "\n".join(lines).strip()
    title = ""
    tm = re.search(r'"title":"((?:[^"\\]|\\.){1,200})"', html)
    if tm:
        raw_title = tm.group(1)
        try:
            title = raw_title.encode("latin1", errors="ignore").decode("unicode_escape", errors="ignore")
        except Exception:
            title = raw_title
        if not title or not re.search(r"[\u4e00-\u9fff]", title):
            title = raw_title
    if not text:
        return None
    return {"text": text, "files": files, "title": title}


def lark_doc_text(p):
    """读取飞书文档正文。
    优先走飞书开放平台 API（app_id/app_secret，可配在 Vercel 环境变量 LARK_APP_ID/LARK_APP_SECRET）；
    未配置时尝试公开文档直抓（文档需设为「互联网上获得链接的人可阅读」）。
    """
    import requests

    url = str(p.get("url") or "").strip()
    document_id = str(p.get("document_id") or "").strip()
    if not document_id and url:
        m = re.search(r"/docx/([A-Za-z0-9]+)", url)
        if m:
            document_id = m.group(1)
    if not document_id:
        raise ValueError("缺少飞书文档链接或 document_id")
    key = str(p.get("key") or "doc")
    fallback_name = str(p.get("name") or "飞书内容库")
    app_id = str(p.get("app_id") or os.getenv("LARK_APP_ID") or "").strip()
    app_secret = str(p.get("app_secret") or os.getenv("LARK_APP_SECRET") or "").strip()
    if app_id and app_secret:
        token = _lark_tenant_token(app_id, app_secret)
        headers = {"Authorization": "Bearer " + token}
        meta_resp = requests.get(LARK_DOC_META.format(doc_id=document_id), headers=headers, timeout=15)
        meta_data = meta_resp.json()
        doc_meta = {}
        if meta_resp.status_code == 200 and meta_data.get("code") in (0, None):
            doc_meta = (meta_data.get("data") or {}).get("document") or {}
        raw_resp = requests.get(LARK_DOC_RAW.format(doc_id=document_id), headers=headers, timeout=30)
        raw_data = raw_resp.json()
        if raw_resp.status_code != 200 or raw_data.get("code") not in (0, None):
            msg = raw_data.get("msg") or str(raw_data)[:200]
            raise RuntimeError("飞书文档读取失败（API）：" + str(msg))
        content = (raw_data.get("data") or {}).get("content") or ""
        if not content.strip():
            raise RuntimeError("飞书文档内容为空（可能文档为空或应用没有该文档查看权限）")
        return {
            "key": key,
            "name": doc_meta.get("title") or fallback_name,
            "text": content[:30000],
            "updated_at": _lark_time(doc_meta.get("update_time")),
            "source": "api",
        }
    if not url:
        url = "https://trip.larkenterprise.com/docx/" + document_id
    raw, _ctype = _safe_fetch(url, timeout=20)
    html = _decode_text(raw)
    login_markers = (
        "loginAppId",
        "crossLoginUrl",
        "grayLogin",
    )
    if any(marker in html for marker in login_markers):
        raise RuntimeError(
            "飞书文档未公开（访问返回登录页）：请在飞书分享设置里把权限改为「互联网上获得链接的人可阅读」，"
            "或在 Vercel 环境变量配置 LARK_APP_ID / LARK_APP_SECRET（企业自建应用）后重试"
        )
    parsed = _lark_docx_parse(html)
    if parsed:
        content = parsed.get("text") or ""
    else:
        content = _lark_public_content(html)
    if not content.strip():
        raise RuntimeError(
            "文档未公开或无法解析：请在飞书里把文档分享改为「互联网上获得链接的人可阅读」，"
            "或在 Vercel 环境变量配置 LARK_APP_ID / LARK_APP_SECRET（企业自建应用，需云文档只读权限）后重试"
        )
    return {
        "key": key,
        "name": (parsed or {}).get("title") or fallback_name,
        "text": content[:30000],
        "files": (parsed or {}).get("files") or [],
        "updated_at": "",
        "source": "public",
    }


def lark_sync(p):
    """同步飞书内容库：逐个拉取文档正文，返回可直接并入知识库的文本列表。"""
    docs = p.get("docs") or []
    if not docs and isinstance(KB.get("lark"), dict):
        docs = KB["lark"].get("docs") or []
    if not docs:
        raise ValueError("未配置飞书文档：knowledge_base.json 的 lark.docs 为空")
    results = []
    for doc in docs:
        try:
            results.append(lark_doc_text(doc))
        except Exception as error:
            results.append(
                {
                    "key": str(doc.get("key") or "doc"),
                    "name": str(doc.get("name") or "飞书内容库"),
                    "error": str(error),
                }
            )
    return {
        "docs": results,
        "synced_at": _cn_now(),
    }


_LARK_KB_CACHE = {"at": 0.0, "docs": None, "error": "", "synced_at": ""}


def knowledge_live():
    """聚合知识库：静态 KB + 飞书内容库（带 10 分钟进程内缓存，避免每次请求都抓飞书）。"""
    import copy
    import time as _time

    merged = copy.deepcopy(KB)
    now = _time.time()
    cached = _LARK_KB_CACHE
    if cached["docs"] is None or now - cached["at"] > 600:
        try:
            synced = lark_sync({})
            docs = synced.get("docs") or []
            cached.update(
                {
                    "at": now,
                    "docs": docs,
                    "error": "",
                    "synced_at": synced.get("synced_at") or "",
                }
            )
        except Exception as error:
            cached.update({"at": now, "docs": [], "error": str(error), "synced_at": ""})
    lark = merged.setdefault("lark", {})
    # docs 保留配置（含 url/document_id，供前端跳转与再次同步）；
    # 同步结果单独放 synced_docs，避免覆盖配置字段
    lark["docs"] = KB.get("lark", {}).get("docs") or []
    lark["synced_docs"] = cached["docs"] or []
    lark["synced_at"] = cached["synced_at"]
    lark["last_error"] = cached["error"]
    return merged


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


def generate(p):
    cat = KB["categories"].get(p.get("category"), {})
    channel = p.get("channel") or "朋友圈"
    needs = p.get("needs") or "无"
    profile = p.get("profile") or ""
    materials = p.get("materials") or ""
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
    live = mp.get("live", {}) or {}
    live_cats = live.get("categories") or []
    wants_compare = bool(re.search(r"对比|比较|分析|竞品|哪个好|哪家好|品牌推荐|选型|区别|差异|怎么选",
                                   str(p.get("needs") or "") + str(p.get("product") or "") + str(p.get("content_type") or "")))
    matched_live = [
        c for c in live_cats
        if wants_compare or not p.get("category") or c.get("name") == p.get("category") or c.get("parent") == p.get("category")
    ]
    live_cat_lines = []
    for c in matched_live[: (10 if wants_compare else 6)]:
        brand_note = "（服务市场在售，可按需对比）" if wants_compare and c.get("brands") else ""
        live_cat_lines.append(
            f"- {c.get('parent')} / {c.get('name')}（cat={c.get('cat')}）："
            f"三级分类：{'、'.join(c.get('sub_categories') or []) or '—'}；"
            f"代表品牌：{'、'.join(c.get('brands') or []) or '—'}{brand_note}；"
            f"在售代表商品：{'；'.join(c.get('sample_products') or []) or '—'}"
        )
    wants_recommendation = bool(re.search(r"推荐|好物|精选|清单|爆款", str(p.get("needs") or "") + str(p.get("content_type") or "")))
    flagship_all = live.get("flagship_products") or []
    kw = str(p.get("needs") or "") + str(p.get("product") or "")
    is_broad_cat = not p.get("category") or p.get("category") in ("product", "platform", "campaign", "insight", "payment")
    kw_tags = ["宠物", "布草", "亲子", "影音", "舒睡", "智能", "机器人", "耗品", "牙具", "毛巾", "床垫", "吹风机", "摄影", "旅拍", "电玩", "电竞", "咖啡", "食材"]
    def kw_score(item):
        name = str(item.get("name") or "") + str(item.get("cat") or "") + str(item.get("note") or "")
        return sum(3 for t in kw_tags if t in kw and t in name)
    flagship = [
        p_ for p_ in flagship_all
        if wants_recommendation or wants_compare or is_broad_cat or not p_.get("cat") or p_["cat"] == p.get("category") or p_["cat"] in str(p.get("category"))
    ]
    flagship.sort(key=kw_score, reverse=True)
    flagship = flagship[: (24 if (wants_recommendation or wants_compare) else 12)]
    flagship_lines = [
        f"- {p_.get('name')}｜{p_.get('cat') or ''}｜{p_.get('price') or ''}｜{p_.get('sales') or ''}"
        f"{'｜' + p_.get('rating') if p_.get('rating') else ''}"
        f"{'｜' + p_.get('coupon') if p_.get('coupon') else ''}"
        f"{'｜' + p_.get('note') if p_.get('note') else ''}"
        for p_ in flagship
    ]
    coupon_lines = [
        f"- ¥{c.get('amount')} {c.get('threshold')}｜{c.get('scope')}"
        f"{'｜' + c.get('note') if c.get('note') else ''}"
        for c in (live.get("key_coupons") or [])
    ]
    stats = live.get("platform_stats") or {}
    kb_extra = "\n".join([
        "服务市场产品体系（写内容时按需引用）：",
        "\n".join(catalog_lines),
        f"官方六大服务保障：{adv.get('official_guarantees', '')}",
        "平台优势：" + "；".join(adv.get("platform_advantages", [])),
    ])
    live_extra = ""
    if live_cats:
        live_parts = [
            f"【服务市场实时商品库（{live.get('updated_at') or '最近抓取'}快照）】",
            f"平台大盘：{stats.get('suppliers') or '—'}家供应商｜年销量{stats.get('annual_sales_orders') or '—'}单｜在售商品{stats.get('sku_count') or '—'}种",
        ]
        if live_cat_lines:
            live_parts.append("当前品类明细：\n" + "\n".join(live_cat_lines))
        if flagship_lines:
            live_parts.append("热销/上新好物参考：\n" + "\n".join(flagship_lines))
        if coupon_lines:
            live_parts.append("当前活动券参考：\n" + "\n".join(coupon_lines))
        if live.get("update_note"):
            live_parts.append("【数据时效说明】" + live["update_note"])
        live_extra = "\n".join(live_parts)
    compare_rule = (
        "6. 本任务需要品牌对比/分析：必须从【服务市场实时商品库】与【热销/上新好物参考】中引用真实在售品牌与商品名"
        "（如红杉树、尊客、恒创、悦诗兰庭、洁柔、小帅、奶龙、B.Duck、梦百合等），逐品牌说明定位、代表商品、价格区间、"
        "销量/好评与适用酒店场景；禁止用“某品牌”“部分品牌”“一些品牌”等含糊表述代替具体品牌名。"
        "若知识库中某品类缺少品牌数据，如实说明“该品类暂无明确品牌数据”，不得编造。"
        if wants_compare else ""
    )
    prompt = f"""你是携程酒店服务市场的资深内容运营，为酒店写真实、生动、可直接发布的中文内容。
{stance}
{product_brief}
{kb_extra}
{live_extra}
知识库大类：{cat.get('name')}；定义：{cat.get('description')}；可参考主题：{cat.get('topics')}
产品/主题：{p.get('product')}
目标视角：{p.get('persona')}
发布渠道/文章类型：{channel}
内容类型：{p.get('content_type')}
生成需求（个性化要求，务必逐一满足）：{needs}
联网研究：{p.get('research') or '无'}
文章风格样本：{str(p.get('style_samples') or '')[:12000]}
风格画像（AI学习总结，生成时严格遵循其语气、句式与结构习惯）：{str(profile)[:6000]}
用户学习素材摘要（提炼要点融入，不要照抄原文）：{str(materials)[:8000]}

【输出格式（必须严格遵守，逐字执行）】
{CHANNEL_FORMATS.get(channel, '按其使用场景输出完整成稿。')}

【硬性要求】
1. 直接输出正文，禁止以“好的”“以下是为您准备的”“根据您的需求”等开头。
2. 禁止复述或总结用户需求；禁止空话、套话、车轱辘话凑字数——字数宁短勿水，严格卡在格式要求范围内。
3. 站在服务市场/商家面向酒店客户的角度展开（除非用户明确要求酒店视角）。
4. 若用户给出已有文案或细节要求（调整细节、强调IP、强调功能、强调价格），先理解原意再改写，不丢失关键信息。
5. 内部数字写成参考值，不编造平台规则；避免“值得注意的是”“综上所述”“在这个…的时代”等AI腔。
{compare_rule}
7. 涉及具体价格、销量、优惠券时，标注“参考价/参考销量”，并提示以服务市场页面为准。"""
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
    style = p.get("style", "")
    scene = p.get("scene", "")
    desc = (p.get("description") or "").strip()
    elements = (p.get("elements") or "").strip()
    style_desc = POSTER_STYLES.get(style, "")
    if style_desc:
        style_line = f" Style: {style_desc}."
    else:
        style_line = " Style: color palette and mood naturally matched to the theme, rich and varied, avoid a single monotonous brand tone."
    scene_desc = POSTER_SCENES.get(scene, "") if scene else ""
    user_part = f" The main subject MUST be exactly: {desc}." if desc else ""
    motif_part = f" Include subtle supporting motifs related to: {elements}." if elements else ""
    scene_part = f" Scene: {scene_desc}." if scene_desc else " Scene: elegant premium hotel environment."
    palette_part = "champagne gold / warm ivory / dark coffee palette." if "香槟" in style or "金色" in style or "轻奢" in style else "a color palette naturally matched to the theme and scene, rich and varied."
    prompt = (
        "Create a vertical 9:16 hotel marketing poster background as professional "
        "commercial photography with a polished advertising look.\n"
        f"Theme of the poster: {product}.\n"
        f"{style_line}{scene_part}{user_part}{motif_part}\n"
        "Composition: one clear realistic subject, generous clean empty space in the "
        "center and lower third for headline text, soft realistic lighting, high "
        "dynamic range, sharp focus, " + palette_part + "\n"
        "Avoid: any text, watermark, logo, distorted faces or bodies, messy collage, "
        "or a flat single-tone look. Keep it natural, vivid and premium."
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
  "colors": ["从这张海报实际主色中提取的2-4个真实色值"],
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
