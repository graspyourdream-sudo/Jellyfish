"""把镜头绑定声音接进**视频生成入参**（断点④的声音侧）。

背景与边界（必须先说清楚，否则又是一次"看起来接上了"）：

按 APIMart / seedance **官方文档**（2026-09-18 实读）：
``generate_audio`` 是"视频带 AI 生成配套音频"的开关（**默认就是 true**），
``audio_urls`` 才是"把参考音频交给我们"的字段（数组，最多 3 条、总时长 ≤15s、
需与参考图/参考视频一起用，**只收公网 URL 或 asset://，不收 base64/本地地址**）。

所以本模块的规则是：

1. 绑定音频解析出的地址**必须是公网绝对地址**（OSS、或配置了 ``local_storage_base_url``），
   才会作为 ``audio_urls`` 进入生成入参；否则**不静默丢弃**，而是明确告诉用户
   "本地/相对地址供应商抓不到，要真正提交需要把音频放到可公网访问的位置"；
2. 首尾帧与参考音频互斥（官方警告）：入参里同时带了首/尾帧时额外给一条冲突提示；
3. ``generate_audio`` 只在调用方**显式**要求时透传 —— 不因为"有绑定声音"就自动改，
   因为那是模型音频、不是用户上传的配音。注意它默认就是 true（要静音需显式传 false）。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.integrations.video_capabilities import audio_input_supported, resolve_video_capability
from app.services.studio.bound_asset_files import resolve_shot_audio_file

async def attach_shot_audio_to_video_input(
    db: AsyncSession,
    *,
    shot_id: str,
    input_payload: dict[str, Any],
    provider: str,
    model: str | None,
) -> list[str]:
    """把该镜头绑定的声音接进 ``input_payload``（``audio_urls``），返回给用户看的提示列表。

    没有任何绑定声音时返回空列表（不制造噪音）。
    """
    warnings: list[str] = []
    audio = await resolve_shot_audio_file(db, shot_id=shot_id)
    if audio is None:
        return warnings

    file_id = str(audio.file_id or "").strip()
    label = audio.asset_name or file_id or "（未命名音频）"
    input_payload["audio_source_file_id"] = file_id or None
    warnings.extend(audio.warnings)

    if not file_id:
        warnings.append(f"镜头绑定了声音「{label}」，但解析不到文件记录，本次生成不会携带音频。")
        return warnings

    if not audio_input_supported(provider=provider, model=model):  # type: ignore[arg-type]
        warnings.append(
            f"镜头已绑定声音「{label}」（file_id={file_id}），但当前视频供应商/模型"
            f"（{provider}/{model or '<default>'}）不接受参考音频：**本次生成请求不会携带它**。"
            "它仍会出现在交付内容里。"
        )
        return warnings

    url = str(getattr(audio, "url", "") or "").strip()
    if not url.startswith(("http://", "https://")):
        warnings.append(
            f"镜头已绑定声音「{label}」（file_id={file_id}），但它解析出的是本地/相对地址"
            f"（{url or '空'}）：供应商抓不到，**本次生成请求不会携带它**。"
            "要真正作为参考音频提交，需要把音频放到可公网访问的位置"
            "（OSS 公网地址，或给本地存储配置可被外部访问的 local_storage_base_url），"
            "或改用供应商的 asset:// 素材通道。它仍会出现在交付内容里。"
        )
        return warnings

    urls = list(input_payload.get("audio_urls") or [])
    if url not in urls:
        urls.append(url)
    input_payload["audio_urls"] = urls[:3]
    warnings.append(f"已把镜头绑定的声音「{label}」作为参考音频加入本次生成请求：{url}")

    conflicts = _audio_frame_conflicts(model=model, input_payload=input_payload)
    if conflicts:
        warnings.append(conflicts)
    return warnings


def _audio_frame_conflicts(*, model: str | None, input_payload: dict[str, Any]) -> str:
    """seedance 官方警告：使用首尾帧图片时参考音频不可用。这里只提示，不静默改写入参。"""
    cap = resolve_video_capability(provider="apimart", model=model)
    if not cap.audio_input_conflicts_with_frame_roles:
        return ""
    has_frames = bool(input_payload.get("first_frame_base64") or input_payload.get("last_frame_base64"))
    if not has_frames:
        return ""
    return (
        "注意：seedance 官方说明「使用首尾帧图片时参考音频不可用」（实测同时发 first_frame_image "
        "与 audio_urls 会被直接 400）。为让参考音频生效，适配器已把首/尾帧**改以 image_urls 提交**"
        "（等同官方文档里的「图生视频（首帧）+ 参考音频」形式）；代价是尾帧不再是严格的结束帧。"
    )


async def describe_shot_audio_for_video(
    db: AsyncSession,
    *,
    shot_id: str,
    provider: str,
    model: str | None,
) -> str:
    """只读描述：这个镜头绑定的声音会不会进入本次视频生成请求。

    给计划预览用的**不花钱**说明；没有绑定声音时返回空串（不制造噪音）。
    """
    audio = await resolve_shot_audio_file(db, shot_id=shot_id)
    if audio is None:
        return ""
    label = audio.asset_name or audio.file_id or "（未命名音频）"
    if not audio_input_supported(provider=provider, model=model):  # type: ignore[arg-type]
        return (
            f"本镜已绑定声音「{label}」（file_id={audio.file_id}）：交付内容会列出它，"
            f"但 {provider}/{model or '<default>'} 不接受参考音频，本次生成请求不会携带它。"
        )
    url = str(getattr(audio, "url", "") or "").strip()
    if not url.startswith(("http://", "https://")):
        return (
            f"本镜已绑定声音「{label}」（file_id={audio.file_id}）：它解析出的是本地/相对地址"
            f"（{url or '空'}），供应商抓不到，本次生成请求不会携带它。"
            "需要把音频放到可公网访问的位置（OSS 公网地址或配置 local_storage_base_url）才能作为参考音频提交。"
        )
    return f"本镜已绑定声音「{label}」，本次生成会把它作为参考音频（audio_urls）提交：{url}"


__all__ = ["attach_shot_audio_to_video_input", "describe_shot_audio_for_video"]
