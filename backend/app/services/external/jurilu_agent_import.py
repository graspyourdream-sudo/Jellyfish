"""巨日禄 分镜提示词导入 — 独立模块。

两步流程:
  1. GET getScriptPage → 获取 scriptId 列表
  2. POST getStoryboardPage/{page}/{size} → 获取每条分镜的 prompt

不 import Streamlit，不 import db，不写文件，不保存 Cookie / Authorization。
"""

from __future__ import annotations

import html as _html
import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlencode, urlparse

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

JURILU_AGENT_PLATFORM_NAME = "巨日禄"

DEFAULT_JURILU_AGENT_LIST_URL = (
    "https://video.jurilu.com/project_management/project_page/snippets/material_list"
)

_SCRIPT_PAGE_PATH = "/api/video/v1/video-script/getScriptPage"
_STORYBOARD_PAGE_PATH = "/api/video/v1/video-storyboard/getStoryboardPage"
_DEFAULT_PAGE_SIZE = 10
_DEFAULT_STORYBOARD_SIZE = 100

_COOKIE_ENV_KEY = "JURILU_COOKIE"
_URL_ENV_KEY = "JURILU_AGENT_LIST_URL"
_AUTH_ENV_KEY = "JURILU_AUTHORIZATION"

# ---------------------------------------------------------------------------
# Cookie / Authorization / URL
# ---------------------------------------------------------------------------


def get_configured_cookie() -> str:
    return str(os.environ.get(_COOKIE_ENV_KEY, "")).strip()


def get_configured_authorization() -> str:
    return str(os.environ.get(_AUTH_ENV_KEY, "")).strip()


def get_configured_agent_list_url() -> str:
    value = str(os.environ.get(_URL_ENV_KEY, "")).strip()
    return value or DEFAULT_JURILU_AGENT_LIST_URL


def resolve_cookie(input_cookie: str = "") -> str:
    if input_cookie and input_cookie.strip():
        return input_cookie.strip()
    return get_configured_cookie()


#: 页面上的中文标签 → 内部模式（用户/旧前端可能直接传中文，静默降级成 auto 是最危险的坑）。
_AUTH_MODE_LABELS: dict[str, str] = {
    "自动": "auto",
    "不发送": "none",
    "不发送（仅 cookie）": "none",
    "不发送(仅 cookie)": "none",
    "仅cookie": "none",
    "仅 cookie": "none",
    "原样发送": "raw",
    "bearer": "bearer",
    "bearer 发送": "bearer",
}


def looks_like_full_cookie(value: str) -> bool:
    """判断一个值是不是**整串浏览器 Cookie**（而不是单个 Authorization 值）。

    为什么必须拦：用户从浏览器复制的「完整 Cookie」第一项就叫 ``Authorization=<jwt>``，
    整串里必然带分号分隔的其它 Cookie。把它当 HTTP ``Authorization`` 头发出去，
    上游只会回 401（真实踩过）。这种情况一律忽略该值，只用 ``Cookie`` 头。
    """
    text = str(value or "").strip()
    if not text:
        return False
    return text.startswith("Authorization=") or ";" in text or "\n" in text


def resolve_authorization(input_auth: str = "", mode: str = "auto") -> Tuple[str, str]:
    """解析本次要发送的 Authorization 值。

    返回 ``(值, 模式说明)``；模式说明会进 diagnostics（``auth_header_mode``），
    额外情况（整串 Cookie 被忽略、未知模式）用 ``auth_note`` 形式一并返回给调用方记录。
    """
    raw_mode = str(mode or "auto").strip()
    normalized = _AUTH_MODE_LABELS.get(raw_mode.lower(), raw_mode.lower())
    if normalized not in ("none", "raw", "bearer", "auto"):
        # 未知取值：**不**静默按 auto 原样发送，退回「不发送」并说明（fail-safe）
        return "", f"unknown:{raw_mode or 'empty'}"
    mode = normalized
    if mode == "none":
        return "", "none"
    auth = (input_auth or "").strip()
    if not auth:
        # auto 不再读环境兜底（那颗雷会凭空加一个 Authorization 头）；只有显式 raw/bearer 才读
        if mode in ("raw", "bearer"):
            auth = get_configured_authorization()
        if not auth:
            return "", "none"
    if looks_like_full_cookie(auth):
        # 整串 Cookie：忽略 Authorization 头，只用 Cookie 头（用户口径）
        return "", "ignored_full_cookie"
    if mode == "bearer":
        if not auth.lower().startswith("bearer "):
            auth = f"Bearer {auth}"
        return auth, "bearer"
    return auth, "raw"


def resolve_agent_list_url(input_url: str = "") -> str:
    if input_url and input_url.strip():
        return input_url.strip()
    return get_configured_agent_list_url()


# ---------------------------------------------------------------------------
# URL 提取 + 请求构造
# ---------------------------------------------------------------------------


def extract_project_clip_from_url(url: str) -> Tuple[str, str]:
    parsed = urlparse(str(url or ""))
    qs = parse_qs(parsed.query)
    pid = (qs.get("projectId") or [""])[0]
    cid = (qs.get("clipId") or [""])[0]
    return pid, cid


def _api_base(source_url: str, override: str, path: str) -> str:
    if override and override.strip():
        return override.strip().rstrip("/")
    parsed = urlparse(str(source_url or "").strip())
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def build_get_script_page_request(
    source_url: str,
    api_url_override: str = "",
    page_no: int = 1,
    page_size: int = _DEFAULT_PAGE_SIZE,
) -> Tuple[str, str]:
    base = _api_base(source_url, api_url_override, _SCRIPT_PAGE_PATH)
    pid, cid = extract_project_clip_from_url(source_url)
    qs = urlencode({"pageNo": str(page_no), "pageSize": str(page_size),
                     "projectId": pid or "", "clipId": cid or ""})
    return (f"{base}?{qs}", "GET")


def build_storyboard_page_request(
    source_url: str,
    script_id: str,
    clip_id: str = "",
    project_id: str = "",
    api_url_override: str = "",
    page: int = 1,
    size: int = _DEFAULT_STORYBOARD_SIZE,
) -> Tuple[str, str, dict]:
    base = _api_base(source_url, api_url_override, _STORYBOARD_PAGE_PATH)
    api_url = f"{base}/{page}/{size}"
    pid, cid = extract_project_clip_from_url(source_url)
    body = {
        "scriptId": int(script_id),
        "clipId": int(clip_id or cid or "0"),
        "projectId": int(project_id or pid or "0"),
    }
    return (api_url, "POST", body)


# ---------------------------------------------------------------------------
# JSON / HTML 解析工具
# ---------------------------------------------------------------------------


def _safe_json_dumps(value: object, limit: int = 3000) -> str:
    try:
        text = json.dumps(value, ensure_ascii=False, indent=2)
    except TypeError:
        text = str(value)
    return text[:limit] + ("..." if len(text) > limit else "")


def _first_present_text(data: dict, keys: List[str]) -> str:
    for key in keys:
        value = data.get(key)
        if isinstance(value, (str, int, float)):
            text = str(value).strip()
            if text:
                return text
    return ""


def _first_present_tags(data: dict) -> List[str]:
    for key in ["tags", "labels", "tagList", "categories"]:
        value = data.get(key)
        if isinstance(value, list):
            tags = []
            for item in value:
                if isinstance(item, dict):
                    text = _first_present_text(item, ["name", "title", "label", "value"])
                else:
                    text = str(item).strip()
                if text:
                    tags.append(text)
            return tags
        if isinstance(value, str) and value.strip():
            return [part.strip() for part in re.split(r"[,，、\s]+", value) if part.strip()]
    return []


def _json_candidates_from_html(text: str) -> List[Any]:
    candidates: List[Any] = []
    source = str(text or "")
    stripped = source.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, (dict, list)):
                candidates.append(parsed)
        except json.JSONDecodeError:
            pass
    script_patterns = [
        r"<script[^>]+id=[\"']__NEXT_DATA__[\"'][^>]*>(.*?)</script>",
        r"<script[^>]+type=[\"']application/json[\"'][^>]*>(.*?)</script>",
    ]
    for pattern in script_patterns:
        for match in re.finditer(pattern, source, flags=re.IGNORECASE | re.DOTALL):
            raw = _html.unescape(match.group(1).strip())
            if not raw:
                continue
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, (dict, list)):
                candidates.append(parsed)
    for marker in ["window.__INITIAL_STATE__", "window.__NUXT__", "window.__APOLLO_STATE__"]:
        idx = source.find(marker)
        if idx < 0:
            continue
        brace_idx = source.find("{", idx)
        if brace_idx < 0:
            continue
        depth = 0
        in_string = False
        escape = False
        end_idx = -1
        for pos in range(brace_idx, min(len(source), brace_idx + 1_500_000)):
            ch = source[pos]
            if in_string:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end_idx = pos + 1
                    break
        if end_idx > brace_idx:
            raw = source[brace_idx:end_idx]
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, (dict, list)):
                candidates.append(parsed)
    return candidates


# ---------------------------------------------------------------------------
# 网络抓取
# ---------------------------------------------------------------------------


def fetch_agent_platform_with_cookie(
    agent_list_url: str,
    cookie_text: str,
    method: str = "GET",
    json_body: Optional[dict] = None,
    authorization: str = "",
    referer: str = "",
) -> dict:
    # 早退分支（URL 缺失 / 域名不对 / 没凭证）+ 成功 + 三类异常，共 8 个 return；
    # 拆小函数会把「头怎么拼、事实怎么取证」拆散，得不偿失。
    # pylint: disable=too-many-return-statements
    clean_url = str(agent_list_url or "").strip()
    clean_cookie = str(cookie_text or "").strip()
    clean_auth = str(authorization or "").strip()
    clean_referer = str(referer or "").strip()
    method = (method or "GET").upper()

    if not clean_url:
        return {"ok": False, "error_type": "页面结构变化", "error": "缺少请求 URL。"}

    parsed_url = urlparse(clean_url)
    if parsed_url.scheme not in {"http", "https"}:
        return {"ok": False, "error_type": "页面结构变化", "error": "URL 必须是 http(s)。"}

    host = parsed_url.netloc
    if ":" in host:
        host = host.rsplit(":", 1)[0]
    host = host.lower()
    if not (host == "jurilu.com" or host.endswith(".jurilu.com")):
        return {"ok": False, "error_type": "页面结构变化", "error": "只支持巨日禄域名。"}

    if not clean_cookie and not clean_auth:
        return {"ok": False, "error_type": "cookie 失效", "error": "请先配置 Cookie 或 Authorization。"}

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json, text/plain, */*",
        "Origin": f"{parsed_url.scheme}://{host}",
        "Accept-Encoding": "gzip, deflate",
    }
    if clean_cookie:
        headers["Cookie"] = clean_cookie
    if clean_auth:
        headers["Authorization"] = clean_auth
    if clean_referer:
        headers["Referer"] = clean_referer

    body_bytes: Optional[bytes] = None
    if method == "POST":
        headers["Content-Type"] = "application/json"
        if json_body:
            body_bytes = json.dumps(json_body, ensure_ascii=False).encode("utf-8")

    request = urllib.request.Request(clean_url, data=body_bytes, headers=headers, method=method)
    facts = _request_facts(headers, clean_cookie)
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8", errors="replace")
            return {
                "ok": True, "url": clean_url, "method": method,
                "status": getattr(response, "status", 0),
                "content_type": response.headers.get("Content-Type", ""),
                "elapsed_ms": int((time.time() - started) * 1000),
                "text": body,
                "fetched_at": datetime.now().isoformat(timespec="seconds"),
                "request_facts": facts,
            }
    except urllib.error.HTTPError as exc:
        error_type = "cookie 失效" if exc.code in {401, 403} else "网络失败"
        try:
            resp_body = exc.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            resp_body = ""
        return _error_result(clean_url, method, exc.code, error_type, f"HTTP {exc.code}",
                             int((time.time() - started) * 1000), bool(clean_cookie),
                             bool(clean_auth), bool(clean_referer), resp_body,
                             request_facts=facts)
    except urllib.error.URLError as exc:
        return _error_result(clean_url, method, None, "网络失败",
                             f"{type(exc.reason).__name__}: {exc.reason}",
                             int((time.time() - started) * 1000), bool(clean_cookie),
                             bool(clean_auth), bool(clean_referer), "",
                             request_facts=facts)
    except Exception as exc:
        return _error_result(clean_url, method, None, "网络失败",
                             f"{type(exc).__name__}: {exc}",
                             int((time.time() - started) * 1000), bool(clean_cookie),
                             bool(clean_auth), bool(clean_referer), "",
                             request_facts=facts)


def cookie_has_authorization_item(cookie_text: str) -> bool:
    """整串 Cookie 里是否有一个**名为 Authorization** 的项。

    只回布尔值：项名可以报，项值绝不能外泄。
    """
    for part in str(cookie_text or "").split(";"):
        name = part.split("=", 1)[0].strip()
        if name.lower() == "authorization":
            return True
    return False


def _request_facts(headers: Dict[str, str], cookie_text: str) -> Dict[str, Any]:
    """真实的**请求头形状**取证：只有头名与布尔值，绝不含头值。

    401 排查时用户要的七件事（URL / 方法 / 状态 / 头名 / 是否带 Cookie /
    Cookie 里是否有 Authorization 项 / 是否错发了 HTTP Authorization 头）里，
    后三件由这里给出，前几件由调用方补齐。
    """
    names = sorted({str(key).lower() for key in headers})
    return {
        "request_header_names": names,
        "sent_cookie_header": "cookie" in names,
        "sent_authorization_header": "authorization" in names,
        "cookie_has_authorization_item": cookie_has_authorization_item(cookie_text),
    }


def _error_result(url, method, status, error_type, error, elapsed_ms,
                  has_cookie, has_auth, has_referer, response_preview="",
                  request_facts: Optional[dict] = None) -> dict:
    payload = {
        "ok": False, "url": url, "method": method, "status": status,
        "error_type": error_type, "error": error, "elapsed_ms": elapsed_ms,
        "has_cookie": has_cookie, "has_auth": has_auth, "has_referer": has_referer,
        "response_preview": _sanitize(response_preview),
    }
    if request_facts:
        # 既有嵌套形状（供两步流程/服务层取用），也摊平一份便于直接看
        payload["request_facts"] = request_facts
        payload.update(request_facts)
    return payload


def _sanitize(text: str) -> str:
    if not text:
        return ""
    cleaned = re.sub(r"eyJ[A-Za-z0-9_-]{30,}", "<JWT>", text)
    return cleaned[:500]


# ---------------------------------------------------------------------------
# 两步导入：getScriptPage → getStoryboardPage
# ---------------------------------------------------------------------------


def fetch_all_storyboards(
    source_url: str,
    cookie_text: str,
    authorization: str = "",
    referer: str = "",
    api_url_override: str = "",
    storyboard_size: int = _DEFAULT_STORYBOARD_SIZE,
) -> dict:
    """两步导入流程。

    Returns:
        {"ok": True/False, "scripts": [...], "storyboards": [...],
         "warnings": [...], "diagnostics": {...}}
    """
    diag: Dict[str, Any] = {}
    warnings: List[str] = []

    # Step 1: getScriptPage → script IDs
    script_url, _ = build_get_script_page_request(source_url, api_url_override=api_url_override)
    diag["getScriptPage_url"] = script_url

    script_result = fetch_agent_platform_with_cookie(
        script_url, cookie_text, method="GET",
        authorization=authorization, referer=referer,
    )
    diag["script_status"] = script_result.get("status")
    diag["script_request_facts"] = script_result.get("request_facts") or {}
    if not script_result.get("ok"):
        return {"ok": False, "scripts": [], "storyboards": [],
                "warnings": [f"获取脚本列表失败: {script_result.get('error')}"],
                "diagnostics": diag}

    scripts = _extract_records_from_response(script_result.get("text", ""))
    diag["script_records_count"] = len(scripts)

    if not scripts:
        return {"ok": False, "scripts": [], "storyboards": [],
                "warnings": ["未获取到脚本记录。"],
                "diagnostics": diag}

    # Step 2: getStoryboardPage for each script
    pid, cid = extract_project_clip_from_url(source_url)
    all_storyboards: List[dict] = []
    fetched_script_ids: List[str] = []
    sb_counts: Dict[str, int] = {}

    for idx, script in enumerate(scripts, start=1):
        sid = str(script.get("id", ""))
        if not sid:
            continue
        fetched_script_ids.append(sid)
        script_title = str(script.get("title", ""))
        script_index = idx

        sb_url, sb_method, sb_body = build_storyboard_page_request(
            source_url, script_id=sid, clip_id=cid, project_id=pid,
            api_url_override=api_url_override, size=storyboard_size,
        )
        diag.setdefault("storyboard_urls", []).append(sb_url)

        sb_result = fetch_agent_platform_with_cookie(
            sb_url, cookie_text, method=sb_method, json_body=sb_body,
            authorization=authorization, referer=referer,
        )
        if not sb_result.get("ok"):
            warnings.append(f"scriptId={sid} 分镜接口失败: {sb_result.get('error')}")
            diag.setdefault("storyboard_request_facts", []).append(
                sb_result.get("request_facts") or {}
            )
            continue

        sbs = _extract_storyboard_records(
            sb_result.get("text", ""), sid,
            script_title=script_title, script_index=script_index,
        )
        sb_counts[sid] = len(sbs)
        all_storyboards.extend(sbs)

    # 排序：script_index → seqNum
    all_storyboards.sort(key=lambda r: (r.get("source_script_index", 0), int(r.get("seqNum", 0) or 0)))

    diag["fetched_script_ids"] = fetched_script_ids
    diag["storyboard_page_size"] = storyboard_size
    diag["storyboard_records_count"] = len(all_storyboards)
    diag["parsed_prompts_count_by_script"] = sb_counts

    if not all_storyboards:
        return {"ok": False, "scripts": scripts, "storyboards": [],
                "warnings": warnings + ["已获取 scriptId，但未解析到分镜。"],
                "diagnostics": diag}

    return {"ok": True, "scripts": scripts, "storyboards": all_storyboards,
            "warnings": warnings, "diagnostics": diag}


def _extract_records_from_response(text: str) -> List[dict]:
    """从 JSON 响应提取 records[]。"""
    candidates = _json_candidates_from_html(text)
    for c in candidates:
        if isinstance(c, dict):
            data = c.get("data")
            if isinstance(data, dict):
                recs = data.get("records")
                if isinstance(recs, list):
                    return [r for r in recs if isinstance(r, dict)]
            recs = c.get("records")
            if isinstance(recs, list):
                return [r for r in recs if isinstance(r, dict)]
    return []


def _extract_storyboard_records(
    text: str, script_id: str,
    script_title: str = "", script_index: int = 0,
) -> List[dict]:
    """从 getStoryboardPage 响应提取分镜记录并标准化。"""
    records = _extract_records_from_response(text)
    result: List[dict] = []
    for rec in records:
        prompt_text = str(rec.get("prompt", "")).strip()
        if not prompt_text:
            continue
        ep = f"EP{script_index:02d}" if script_index else ""
        sbid = str(rec.get("sbid", ""))
        title_part = f"｜{script_title}" if script_title else ""
        display_name = f"{ep}{title_part}｜分镜 {sbid}" if ep or title_part else f"分镜 {sbid}"
        result.append({
            "agent_id": str(rec.get("id", "")),
            "agent_name": display_name,
            "prompt_text": prompt_text,
            "shot_summary": str(rec.get("description", "")),
            "shot_id": str(rec.get("id", "")),
            "sbid": sbid,
            "seqNum": str(rec.get("seqNum", "")),
            "modelName": str(rec.get("modelName", "")),
            "aspectRatio": str(rec.get("aspectRatio", "")),
            "duration": str(rec.get("duration", "")),
            "resolution": str(rec.get("resolution", "")),
            "amount": str(rec.get("amount", "")),
            "originalText": str(rec.get("originalText", "")),
            "characters": rec.get("characters", ""),
            "scriptId": script_id,
            "source_script_id": script_id,
            "source_script_title": script_title,
            "source_script_index": script_index,
            "episode_hint": ep,
            "source_platform": JURILU_AGENT_PLATFORM_NAME,
            "source_url": "",
            "fetched_at": datetime.now().isoformat(timespec="seconds"),
            "raw_data": _safe_json_dumps(rec),
            "parse_status": "已识别",
        })
    return result


# ---------------------------------------------------------------------------
# parse_agent_platform_response — kept for backward compat
# ---------------------------------------------------------------------------


def _walk_json_dicts(value: object, limit: int = 2000) -> List[dict]:
    found: List[dict] = []
    def walk(node: object) -> None:
        if len(found) >= limit:
            return
        if isinstance(node, dict):
            found.append(node)
            for child in node.values():
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)
    walk(value)
    return found


def _agent_from_json_object(obj: dict, source_url: str, fetched_at: str) -> Optional[dict]:
    name = _first_present_text(obj, ["title", "agent_name", "agentName", "name", "templateName", "roleName", "botName"])
    agent_id = _first_present_text(obj, ["id", "uid", "agent_id", "agentId", "templateId", "materialId", "snippetId"])
    prompt_text = _first_present_text(obj, ["scriptContent", "prompt_text", "promptText", "prompt", "systemPrompt", "templatePrompt", "instruction", "instructions", "content"])
    description = _first_present_text(obj, ["description", "desc", "summary", "intro", "remark"])
    tags = _first_present_tags(obj)
    has_agent_signal = bool(name or prompt_text) and any(k in obj for k in ["title", "scriptContent", "agent_name", "agentName", "name", "prompt_text", "promptText", "prompt", "systemPrompt", "templatePrompt", "instruction", "instructions"])
    if not has_agent_signal:
        return None
    return {"agent_name": name or f"未命名 Agent {agent_id}".strip(), "agent_id": agent_id, "prompt_text": prompt_text, "description": description, "tags": tags, "source_platform": JURILU_AGENT_PLATFORM_NAME, "source_url": source_url, "fetched_at": fetched_at, "raw_data": _safe_json_dumps(obj), "parse_status": "已识别" if prompt_text else "未识别提示词字段"}


def parse_agent_platform_response(fetch_result: dict) -> dict:
    """解析单次 fetch 响应（getScriptPage 或其他 JSON API）。"""
    if not fetch_result.get("ok"):
        return {"agents": [], "warnings": [fetch_result.get("error_type", "抓取失败")],
                "debug": fetch_result}
    text = str(fetch_result.get("text") or "")
    source_url = str(fetch_result.get("url") or "")
    fetched_at = str(fetch_result.get("fetched_at") or datetime.now().isoformat(timespec="seconds"))
    records = _extract_records_from_response(text)
    agents: List[dict] = []
    for rec in records:
        name = str(rec.get("title", rec.get("name", "")))
        sid = str(rec.get("id", ""))
        prompt = str(rec.get("scriptContent", rec.get("prompt", "")))
        agents.append({
            "agent_id": sid, "agent_name": name or f"脚本 {sid}",
            "prompt_text": prompt,
            "description": "", "tags": [],
            "source_platform": JURILU_AGENT_PLATFORM_NAME,
            "source_url": source_url, "fetched_at": fetched_at,
            "raw_data": _safe_json_dumps(rec),
            "parse_status": "已识别" if prompt else "无脚本内容",
        })
    warnings = []
    if not agents:
        warnings.append("未识别到条目。")
    return {
        "agents": agents, "warnings": warnings,
        "debug": {
            "url": source_url, "method": fetch_result.get("method", ""),
            "status": fetch_result.get("status", ""),
            "content_type": fetch_result.get("content_type", ""),
            "elapsed_ms": fetch_result.get("elapsed_ms", ""),
            "records_count": len(records),
            "parsed_prompts_count": len(agents),
            "raw_preview": text[:3000],
        },
    }


# ---------------------------------------------------------------------------
# 标准化输出
# ---------------------------------------------------------------------------


def normalize_external_agent_prompts(agents: List[dict]) -> List[dict]:
    entries: List[dict] = []
    for index, agent in enumerate(agents, start=1):
        prompt_text = str(agent.get("prompt_text") or "").strip()
        if not prompt_text:
            continue
        agent_name = str(agent.get("agent_name") or "").strip() or f"Agent {index}"
        entries.append({
            "shot_label": agent_name,
            "description": str(agent.get("shot_summary") or agent.get("description") or agent_name).strip(),
            "final_prompt": prompt_text,
            "model": str(agent.get("modelName") or f"{JURILU_AGENT_PLATFORM_NAME} Agent"),
            "duration": str(agent.get("duration") or "5"),
            "size": str(agent.get("aspectRatio") or "9:16"),
            "resolution": str(agent.get("resolution") or "720p"),
            "agent_name": agent_name,
            "agent_id": str(agent.get("agent_id") or ""),
            "source_platform": JURILU_AGENT_PLATFORM_NAME,
            "source_url": str(agent.get("source_url") or ""),
            "fetched_at": str(agent.get("fetched_at") or ""),
            "raw_data": str(agent.get("raw_data") or ""),
        })
    return entries
