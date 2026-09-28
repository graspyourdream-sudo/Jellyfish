"""把镜头绑定声音接进**视频生成入参**（断点④的声音侧）。

**权威口径来源**：``SIX_STEP_ACCEPTANCE.md`` 第 128 行的官方协议要点表
（``audio_urls`` | 参考音频（数组）| 最多 3 条、总时长 ≤15s、需与参考图/参考视频一起用、
**只收公网 URL 或 `asset://`**、**与首尾帧图片互斥**）。
本模块的准入判定与那份口径对齐，实现状态见 :func:`classify_audio_input` 的说明
（其中"最多 3 条"已强制；**时长上限**与"需与参考图/参考视频一起用"**文档已记录、代码未强制**）。

背景与边界（必须先说清楚，否则又是一次"看起来接上了"）：

按 APIMart / seedance **官方文档**（2026-09-18 实读）：
``generate_audio`` 是"视频带 AI 生成配套音频"的开关（**默认就是 true**），
``audio_urls`` 才是"把参考音频交给我们"的字段（数组，最多 3 条、总时长 ≤15s、
需与参考图/参考视频一起用，**只收公网 URL 或 asset://，不收 base64/本地地址**）。

**术语必须分清（本轮的口径，别混为一谈）**：

- **参考音频**（reference audio）：作为**输入**参与生成 —— 绑定声音 → ``audio_urls`` →
  供应商请求（语义是"参考"：音色 / 口型 / 说话内容）。本轮我们只验证到**请求计划层**
  （哪些地址会 / 不会进请求、为什么），"供应商真实接受并据此影响结果"**仍是未验证**
  （需要一次真实付费出视频，本轮没做）。
- **最终成片的音轨**：成片里那条声音轨 —— 当前来自供应商侧 ``generate_audio``（模型
  自己生成，默认开）；把**已生成的音频**当作成片音轨"回贴 / 混流"是**另一条路径**，
  本仓库**还没有实现**（没有 ffmpeg 混流，交付文本里的「声音：」行只是**清单**）。

所以：**不许**对外宣称"已支持参考音频影响生成"。能说的只有一句：
"参考音频会进入供应商请求（本轮仅在请求计划层验证）"。
完整说明（含计划响应字段、准入口径表、未验证部分）见 ``docs/reference-audio-scope.md``。

**"这一镜该用哪条声音"的唯一口径**（顺序即优先级，只有
:func:`resolve_audio_admission` 一处实现）：

1. ``shot_details.audio_opt_out`` = true → 本镜明确无需声音（覆盖一切继承）；
2. **人物资产当前绑定的角色声音**（第 2 步「人物资产详情」是全站唯一绑定入口）；
3. ``shot_details.audio_file_id`` → 迁移 009 之前的逐镜声音，**只作兼容快照兜底**，
   永不覆盖第 2 步的人物资产音色；
4. 都没有 → 未绑定。

角色声音**只认人物资产**：场景 / 道具 / 服装上的历史 ``asset_voice`` 行、
配乐 / 环境音 / 音效 / 最终成片音轨都不参与，也不会制造"多个候选"的歧义。

准入口径只有一处（:func:`classify_audio_input`，本模块）：

1. 只有**公网 http(s)** 或 **``asset://``** 的音频才允许进入请求；
2. 本机相对路径 / 内网地址（127./10./172.16-31./192.168./169.254./localhost/*.local）
   / 供应商不接受的 data URL → **在请求计划层就被排除**，并给出 ``excluded_reason``；
3. 未绑定 / 明确无需声音 → 明确说"未绑定"或"本镜无需声音"，不制造噪音；
4. 计划（``describe_plan_audio``）与提交（``attach_shot_audio_to_video_input``）
   走的是**同一个函数**，不再各写一份判断。

另外：

- ``generate_audio`` 只在调用方**显式**要求时透传 —— 不因为"有绑定声音"就自动改，
  因为那是模型音频、不是用户上传的配音。注意它默认就是 true（要静音需显式传 false）。
- 首尾帧与参考音频互斥（官方警告）：入参里同时带了首/尾帧时额外给一条冲突提示；
  适配器会把首/尾帧**改以 ``image_urls`` 提交**（避免供应商 400）——
  这是"改写 + 提示"，不是硬拦，也不代表参考音频因此被采用（尚未验证）。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.integrations.video_capabilities import audio_input_supported
from app.services.studio.bound_asset_files import resolve_shot_audio_file

# ---------------------------------------------------------------------------
# 术语澄清（唯一一份文案，页面 / 计划响应 / 文档都用它，避免各写一遍说法不一致）
# ---------------------------------------------------------------------------

REFERENCE_AUDIO_TERMS_NOTE = (
    "「参考音频」与「最终成片的音轨」是两件事：参考音频是**输入**"
    "（绑定声音 → audio_urls → 供应商请求，本轮只在**请求计划层**验证它会被带进请求，"
    "供应商是否据此影响生成结果尚无真实证据）；最终成片的音轨来自供应商侧 "
    "generate_audio（模型自己生成），把已生成的音频混流/回贴成成片音轨是**另一条路径**，"
    "当前未实现。"
)

# 准入/排除状态（机器可读；页面按它选文案，不自己拼字符串）
STATE_INCLUDED_PUBLIC = "public_url"
STATE_INCLUDED_ASSET = "asset_ref"
STATE_INCLUDED_DATA_URL_INLINE = "data_url_inline"
STATE_NOT_BOUND = "not_bound"
STATE_OPT_OUT = "opt_out"
STATE_FILE_MISSING = "file_missing"
STATE_VENDOR_UNSUPPORTED = "vendor_unsupported"
STATE_NO_ADDRESS = "no_address"
STATE_LOCAL_PATH = "local_path"
STATE_PRIVATE_ADDRESS = "private_address"
STATE_DATA_URL_REJECTED = "data_url_rejected"

#: 会被真的放进 ``audio_urls`` 的状态（页面/计划据此说"本次携带"）
INCLUDED_STATES: frozenset[str] = frozenset(
    {STATE_INCLUDED_PUBLIC, STATE_INCLUDED_ASSET, STATE_INCLUDED_DATA_URL_INLINE}
)

# 这条声音是从哪来的（审计用；顺序即 ``resolve_audio_admission`` 的优先级）。
#: 来自**人物资产**当前绑定的角色声音（唯一事实来源）
VOICE_SOURCE_CHARACTER_ASSET = "character_asset"
#: 来自迁移 009 之前的逐镜声音快照（**兼容口**，只在人物资产没有音色时兜底）
VOICE_SOURCE_LEGACY_SNAPSHOT = "legacy_shot_snapshot"
#: 本镜不携带任何声音（未绑定 / 明确无需声音 / 多个人物音色无法判定）
VOICE_SOURCE_NONE = "none"

_HTTP_PREFIXES = ("http://", "https://")


@dataclass(frozen=True, slots=True)
class AudioAdmission:
    """一个镜头绑定音频的**准入结论**（计划与提交共用；不可变，便于断言）。"""

    included: bool
    state: str
    reason_code: str = ""
    file_id: str = ""
    label: str = ""
    #: 真正会进请求的地址（公网 http(s) / ``asset://`` / 供应商接受的 data URL）；未携带时为空
    url: str = ""
    #: 解析出来的原始地址（可能不可用：本机路径 / 内网 / data URL），仅供技术详情展示
    declared_url: str = ""
    #: 未携带时的一句话原因（未绑定时写「未绑定」）
    excluded_reason: str = ""
    #: 未携带时的补救办法（可操作；已携带时为空）
    how_to_fix: str = ""
    #: 给用户看的完整说明（已携带=「会作为参考音频提交」；未携带=原因），可直接进 warnings
    note: str = ""
    vendor_supports_reference_audio: bool = False
    opt_out: bool = False
    #: 这条声音的来源（``VOICE_SOURCE_*``）：人物资产 / 兼容快照 / 无
    source: str = VOICE_SOURCE_NONE
    #: 绑定解析带出来的其它告警（例如 files 表里查不到该 file_id）
    extra_warnings: tuple[str, ...] = ()

    def to_read(self) -> dict[str, Any]:
        """给计划/预览响应用的审计结构（``included`` / ``file_id`` / ``url`` / ``excluded_reason``）。"""
        return {
            "included": self.included,
            "file_id": self.file_id,
            "url": self.url,
            "declared_url": self.declared_url,
            "excluded_reason": self.excluded_reason,
            "reason_code": self.reason_code,
            "how_to_fix": self.how_to_fix,
            "state": self.state,
            "vendor_supports_reference_audio": self.vendor_supports_reference_audio,
            "voice_source": self.source,
            "note": REFERENCE_AUDIO_TERMS_NOTE,
        }


def _is_private_or_loopback(url: str) -> bool:
    """地址是否指向本机/内网。判定只有一份实现：``reference_preflight``。"""
    from app.services.studio.image_pipeline.reference_preflight import is_loopback_or_private_url

    return is_loopback_or_private_url(url)


def _host_of(url: str) -> str:
    import httpx

    try:
        return str(httpx.URL(url).host or "")
    except Exception:  # noqa: BLE001 - 解析不了就只展示原文
        return ""


def classify_audio_input(  # pylint: disable=too-many-return-statements
    *,
    file_id: str | None,
    url: str | None,
    provider: str,
    model: str | None = None,
    label: str = "",
    opt_out: bool = False,
    file_found: bool = True,
    extra_warnings: tuple[str, ...] = (),
    source: str = VOICE_SOURCE_NONE,
) -> AudioAdmission:
    """**唯一**的参考音频准入口径（纯函数，不碰 DB、不发请求）。

    注意职责边界：本函数只判"**给定的这条**声音能不能进请求"，
    "该用哪条声音"（opt_out → 人物资产音色 → 兼容快照 → 无）由
    :func:`resolve_audio_admission` 决定，且**只有那一处**。``source`` 只是把
    那条结论的来源如实带回审计结构（人物资产 / 兼容快照 / 无），不参与判定。

    判定顺序（先"有没有绑定/有没有文件"，再"供应商吃不吃"，最后"地址形态对不对"）：

    1. 没绑 file_id 且标记了「无需声音」→ ``opt_out``（明确表态，不是漏绑）；
    2. 没绑 file_id → ``not_bound``（原因就写「未绑定」）；
    3. file_id 查不到文件记录 → ``file_missing``；
    4. 供应商/模型不接受参考音频（``audio_input_supported=False``）→ ``vendor_unsupported``；
    5. 解析不出地址 → ``no_address``；
    6. data URL → 供应商接受则携带（``data_url_inline``），不接受则 ``data_url_rejected``；
    7. 内网 / 本机地址（127. / 10. / 172.16-31. / 192.168. / 169.254. / localhost / *.local）
       → ``private_address``（**即使它以 http:// 开头也不能进请求**）；
    8. ``http(s)://`` / ``asset://`` → **携带**（``public_url`` / ``asset_ref``）；
    9. 其余（本机相对路径如 ``/files/x.mp3``、任意非 http 前缀）→ ``local_path``。

    以上任一步排除都返回 ``excluded_reason``（可展示）+ ``how_to_fix``（可操作），
    绝不静默丢弃。返回的 ``url`` 只在**携带**时非空 —— 它就是会进 ``audio_urls`` 的那个值。

    **与官方协议（``SIX_STEP_ACCEPTANCE.md`` 第 128 行）的对账**：

    | 协议约束 | 本仓库状态 |
    |---|---|
    | 只收公网 URL 或 ``asset://`` | ✅ 强制（本函数） |
    | 最多 3 条 | ✅ 强制，但**截断写死在两处**（本模块 ``[:3]`` 与
      ``apimart/video_payload.py``），能力值 ``max_audio_inputs`` 无人读 → 建议收敛成一处 |
    | 总时长 ≤15s | ❌ **文档已记录、代码未强制**（``max_audio_seconds`` 声明了但没人读；
      ``files`` 表也没有音频时长字段 → 想校验得先有数据源） |
    | 需与参考图/参考视频一起用 | ❌ **文档已记录、代码未强制**（``audio_input_requires_reference``
      声明了但没人读；实测纯文本 + 参考音频也会发出 ``audio_urls``） |
    | 与首尾帧图片互斥 | ⚠️ 部分：只产出一条中文冲突提示，适配器把首/尾帧**改以 ``image_urls`` 提交**
      （避免供应商 400），**不是硬拦** |
    """
    clean_id = str(file_id or "").strip()
    clean_url = str(url or "").strip()
    label_text = str(label or "").strip() or clean_id or "（未命名音频）"
    vendor_supports = audio_input_supported(provider=provider, model=model)  # type: ignore[arg-type]

    def make(  # noqa: PLR0913 - 内部小工厂，参数就是结论字段
        included: bool,
        state: str,
        reason_code: str = "",
        excluded_reason: str = "",
        how_to_fix: str = "",
        note: str = "",
        ref: str = "",
    ) -> AudioAdmission:
        # 没给 note 时，用"原因 + 修法"组成给用户看的完整说明（绝不静默丢弃）
        text = note or f"{excluded_reason} {how_to_fix}".strip()
        return AudioAdmission(
            included=included,
            state=state,
            reason_code=reason_code,
            file_id=clean_id,
            label=label_text,
            url=ref,
            declared_url=clean_url,
            excluded_reason=excluded_reason,
            how_to_fix=how_to_fix,
            note=text,
            vendor_supports_reference_audio=vendor_supports,
            opt_out=opt_out,
            source=source,
            extra_warnings=extra_warnings,
        )

    if not clean_id:
        if opt_out:
            return make(
                False,
                STATE_OPT_OUT,
                "opt_out",
                excluded_reason="本镜已明确标记「无需声音」：本次生成请求不携带参考音频。",
                note=f"本镜已明确标记无需声音（{label_text}）：本次生成请求不携带参考音频。",
            )
        return make(
            False,
            STATE_NOT_BOUND,
            "not_bound",
            excluded_reason="未绑定：这条镜头没有绑定任何声音文件，本次生成请求不携带参考音频。",
            how_to_fix=(
                "要带参考音频请到第 2 步「人物资产详情」给这一镜关联的人物绑定音色"
                "（角色声音绑在**人物资产**上，本镜没有单独配声音的入口）；"
                "这一镜确实不需要声音就明确标记「本镜无需声音」。"
            ),
        )

    if not file_found:
        return make(
            False,
            STATE_FILE_MISSING,
            "file_missing",
            excluded_reason=(
                f"已绑定声音「{label_text}」（file_id={clean_id}），但素材库里查不到这个文件记录："
                "供应商无法访问，本次生成请求不携带它。"
            ),
            how_to_fix=(
                "请到第 2 步「人物资产详情」重新上传或重新选择这一镜人物资产的音色"
                "（旧素材记录可能已被删除）；本镜没有单独配声音的入口。"
            ),
        )

    if not vendor_supports:
        return make(
            False,
            STATE_VENDOR_UNSUPPORTED,
            "vendor_unsupported",
            excluded_reason=(
                f"已绑定声音「{label_text}」（file_id={clean_id}），但当前视频供应商/模型"
                f"（{provider}/{model or '<default>'}）**不接受参考音频**：本次生成请求不会携带它。"
                "它仍会出现在交付内容里。"
            ),
            how_to_fix="换用支持参考音频的模型（当前 seedance 2.0 系列支持），或接受「本次只带画面」的生成结果。",
        )

    if not clean_url:
        return make(
            False,
            STATE_NO_ADDRESS,
            "no_address",
            excluded_reason=(
                f"已绑定声音「{label_text}」（file_id={clean_id}），但它解析不出可公网访问的地址："
                "这个音频对象在存储里读不到（对象不存在 / 没权限），"
                "或者它只是本地/相对地址而没配可被外部访问的基址。"
                "供应商抓不到，本次生成请求不携带它。"
            ),
            how_to_fix=(
                "确认该音频对象真的写入了存储（必要时重新上传一次）；"
                "若是本地存储，请配置可被外部访问的 local_storage_base_url，"
                "或把音频换成 OSS 公网地址 / asset:// 素材地址后再生成。"
            ),
        )

    lowered = clean_url.lower()
    if lowered.startswith("data:"):
        from app.utils.files import vendor_accepts_data_url

        if vendor_accepts_data_url(provider):
            return make(
                True,
                STATE_INCLUDED_DATA_URL_INLINE,
                ref=clean_url,
                note=(
                    f"已把本镜使用的角色声音「{label_text}」作为参考音频（audio_urls，内嵌 base64）"
                    f"加入本次生成请求：当前供应商按内嵌解析，不需要外网抓取。"
                ),
            )
        return make(
            False,
            STATE_DATA_URL_REJECTED,
            "data_url_rejected",
            excluded_reason=(
                f"已绑定声音「{label_text}」（file_id={clean_id}），但它解析出的是内嵌 base64"
                f"（data URL），而 {provider} 不接受 data URL 形式的音频入参：本次生成请求不携带它。"
            ),
            how_to_fix="请先把音频放到公网（OSS 等）或登记成 asset:// 素材地址后再生成。",
        )

    if clean_url.startswith(_HTTP_PREFIXES) and _is_private_or_loopback(clean_url):
        host = _host_of(clean_url)
        return make(
            False,
            STATE_PRIVATE_ADDRESS,
            "private_address",
            excluded_reason=(
                f"已绑定声音「{label_text}」（file_id={clean_id}），但它指向本机/内网地址"
                f"（{host or clean_url}）：别人的服务器一定取不到，本次生成请求不携带它。"
            ),
            how_to_fix="请换成公网可访问的 http(s) 地址（OSS 等），或改用供应商的 asset:// 素材通道。",
        )

    if clean_url.startswith(_HTTP_PREFIXES):
        return make(
            True,
            STATE_INCLUDED_PUBLIC,
            ref=clean_url,
            note=f"已把本镜使用的角色声音「{label_text}」作为参考音频（audio_urls）加入本次生成请求：{clean_url}",
        )

    if lowered.startswith("asset://"):
        return make(
            True,
            STATE_INCLUDED_ASSET,
            ref=clean_url,
            note=(
                f"已把本镜使用的角色声音「{label_text}」作为参考音频（audio_urls，供应商私有素材通道 "
                f"asset://）加入本次生成请求：{clean_url}"
            ),
        )

    return make(
        False,
        STATE_LOCAL_PATH,
        "local_path",
        excluded_reason=(
            f"已绑定声音「{label_text}」（file_id={clean_id}），但它解析出的是本地/相对地址"
            f"（{clean_url}）：供应商抓不到，本次生成请求不会携带它。"
            "要真正作为参考音频提交，需要把音频放到可公网访问的位置"
            "（OSS 公网地址，或给本地存储配置可被外部访问的 local_storage_base_url），"
            "或改用供应商的 asset:// 素材通道。它仍会出现在交付内容里。"
        ),
        how_to_fix=(
            "把音频上传到公网（OSS 等），或用 POST /api/v1/studio/files/external 登记一个公网音频地址后重新绑定。"
        ),
    )


#: 角色声音只认**人物资产**：镜头绑定的人物槽位 → 资产类型。
#:
#: 刻意**只有这一项**。场景 / 道具 / 服装上的 ``asset_voice`` 行是历史兼容数据，
#: **不参与角色声音**（配乐 / 环境音 / 音效 / 最终成片音轨更不在其中，它们连
#: ``asset_voice`` 都不是）。把它们也算进来的代价不只是"多带一条声音"：
#: 一个镜头只要绑了带声音的场景，结论就变成"多个候选"→ 角色声音被挤掉不生效 ——
#: 这正是本次要修的缺陷。
_CHARACTER_VOICE_SLOT: dict[str, str] = {"characters": "character"}


@dataclass(frozen=True, slots=True)
class AssetVoiceCarry:
    """这一镜**该用的角色声音**（从人物资产继承）的结论。

    三种状态，**第三种是刻意留出来的**（评审附带条件②：不许猜）：

    - ``none``：这一镜绑定的人物资产里没有一个带声音 → 本函数不提供声音
      （调用方是否退回"兼容快照"由 ``resolve_audio_admission`` 决定）；
    - ``single``：**恰好一个**人物资产绑了声音 → 就是它，视频生成必须用它；
    - ``ambiguous``：**多个**人物资产各自绑了声音 → **不替用户选**，留空并说清是哪几个。
      多人物镜头随便挑一个声音，比没有声音更糟糕。
    """

    state: str = "none"
    file_id: str = ""
    url: str = ""
    #: 声音来自哪个资产（中文标签，如「角色「苏晚棠」」）
    asset_label: str = ""
    #: 候选资产的中文名（``ambiguous`` 时非空，进说明）
    candidates: tuple[str, ...] = ()
    #: 给用户看的说明（``ambiguous`` 时必填；``none`` 时为空串，不制造噪音）
    note: str = ""


async def resolve_asset_voice_for_shot(db: AsyncSession, *, shot_id: str) -> AssetVoiceCarry:
    """读出这一镜**该用的角色声音**：**只认人物资产**（第 2 步是全站唯一的绑定入口）。

    口径（与 ``asset_voices.read_shot_voice_inheritance`` 读的是同一份事实来源）：

    - ``single``：恰好一个**人物资产**绑了声音 → 就是它，调用方必须用它；
    - ``ambiguous``：多个**人物资产**各自绑了声音 → **不替用户挑**，留空 + 列出候选；
    - ``none``：这一镜的人物资产没有一个带声音 → 本函数不提供声音。

    为什么只查``characters`` 槽位：角色声音属于**人物资产**。场景 / 道具 / 服装上的
    ``asset_voice`` 行是历史兼容数据，既不当候选、也不制造"多个候选"的歧义
    （否则一条场景环境音就能把人物音色挤掉）。
    """
    from app.services.studio.asset_voices import read_asset_voices
    from app.services.studio.bound_asset_files import bound_asset_ids_for_shot

    bound = await bound_asset_ids_for_shot(db, shot_id=shot_id)
    by_type: dict[str, list[str]] = {}
    names: dict[tuple[str, str], str] = {}
    for slot, asset_type in _CHARACTER_VOICE_SLOT.items():
        for asset_id, asset_name in (bound.get(slot) or {}).items():
            by_type.setdefault(asset_type, []).append(str(asset_id))
            names[(asset_type, str(asset_id))] = str(asset_name or "")

    voices = await read_asset_voices(db, asset_ids_by_type=by_type)
    if not voices:
        return AssetVoiceCarry(state="none")

    # 顺序稳定：按资产名 + 资产 ID，保证同一份数据每次结论一致
    ordered = sorted(
        voices.values(),
        key=lambda item: (names.get((item.asset_type, item.asset_id), ""), item.asset_id),
    )

    if len(ordered) > 1:
        labels = tuple(
            f"{item.asset_label}「{names.get((item.asset_type, item.asset_id)) or item.asset_id}」"
            for item in ordered
        )
        return AssetVoiceCarry(
            state="ambiguous",
            candidates=labels,
            note=(
                f"本镜关联了 {len(ordered)} 个人物资产、它们各自绑了音色（{'、'.join(labels)}）："
                "系统不替你挑其中一个 —— 挑错会把这一镜的声音配错人。"
                "请确认这一镜是否真的需要多个人物音色同时参与（当前一条参考音频只承载一位人物的音色），"
                "必要时把这一镜拆开，或先在剧本/分镜层确认这几位人物在本镜各自说了什么。"
            ),
        )

    only = ordered[0]
    label = f"{only.asset_label}「{names.get((only.asset_type, only.asset_id)) or only.asset_id}」"
    return AssetVoiceCarry(
        state="single",
        file_id=only.file_id,
        url=only.url,
        asset_label=label,
        note=f"本镜没有单独声明声音，已按人物资产继承{label}当前绑定的音色。",
    )


async def resolve_audio_admission(
    db: AsyncSession,
    *,
    shot_id: str,
    provider: str,
    model: str | None,
) -> AudioAdmission:
    """从库里解析本镜**该用哪条声音** → 走 :func:`classify_audio_input` 得到准入结论。

    **计划与提交都必须经这个入口**：以前两边各写一份"公网地址才带"的判断，
    结果 ``asset://`` 与内网地址在两处的结论不一致（页面说能带、提交却剔除）。

    「用哪条声音」的**唯一口径**（顺序即优先级，**不得再改回按镜头优先**）：

    1. ``shot_details.audio_opt_out`` = true → **本镜明确无需声音**，覆盖一切继承
       （这是镜头级唯一的合法声明）；
    2. **人物资产当前绑定的角色声音**（第 2 步「人物资产详情」是全站唯一的绑定入口）。
       只要人物资产有音色，生成就必须读它 —— 用户在第 2 步换音色，
       所有关联镜头下次生成自动用新音色，不需要逐镜改；
    3. ``shot_details.audio_file_id`` —— 迁移 009 之前留下的**兼容快照**，
       **只在人物资产没有音色时兜底**，并且**永远不覆盖**人物资产的声音；
    4. 都没有 → 未绑定（不制造噪音）。

    第 2 步的 ``ambiguous``（多个**人物资产**各自有音色）**不挑一个**，也**不退回快照**：
    退回快照等于用一条历史逐镜声音冒充角色声音，会与用户刚在第 2 步改过的音色互相矛盾。

    地址取自**两个来源**：

    1. ``files.storage_key`` 本身就是供应商接受的绝对引用（``http(s)://`` / ``asset://``）
       → **直通**。与帧参考图那条路同源（``resolve_vendor_image_ref`` 用
       ``is_public_storage_key`` 直通），否则 ``asset://`` 素材会被当成相对 key 去
       对象存储里找 → 解析失败 → 明明是合法地址却被判"不可携带"；
    2. 否则用解析出来的地址（公网基址 / 本机回放地址），是"本机回放地址"时由
       :func:`classify_audio_input` 判为 ``local_path`` 并说明原因。
    """
    from app.models.studio import FileItem, ShotDetail
    from app.utils.files import is_public_storage_key

    detail = await db.get(ShotDetail, shot_id)
    opt_out = bool(getattr(detail, "audio_opt_out", False)) if detail is not None else False
    legacy_file_id = str(getattr(detail, "audio_file_id", "") or "").strip() if detail is not None else ""

    # ① opt_out：镜头级唯一的合法声明，一票否决（连兼容快照也不用）
    if opt_out:
        return classify_audio_input(
            file_id="",
            url="",
            provider=provider,
            model=model,
            opt_out=True,
            source=VOICE_SOURCE_NONE,
        )

    # ② 人物资产当前绑定的角色声音（唯一事实来源）
    carry = await resolve_asset_voice_for_shot(db, shot_id=shot_id)
    if carry.file_id:
        carry_obj = await db.get(FileItem, carry.file_id)
        carry_key = str(getattr(carry_obj, "storage_key", "") or "").strip()
        carry_url = carry_key if is_public_storage_key(carry_key) else str(carry.url or "")
        return classify_audio_input(
            file_id=carry.file_id,
            url=carry_url,
            provider=provider,
            model=model,
            # 标签用音频文件名（用户认得的那一个）；来源（哪个人物资产）在 carry.note 里说清
            label=str(getattr(carry_obj, "name", "") or "") or carry.asset_label or carry.file_id,
            opt_out=False,
            file_found=carry_obj is not None,
            extra_warnings=(carry.note,) if carry.note else (),
            source=VOICE_SOURCE_CHARACTER_ASSET,
        )

    if carry.state == "ambiguous":
        # 多个人物资产各有音色：不挑、也不退回历史快照（说明在 carry.note 里）。
        return classify_audio_input(
            file_id="",
            url="",
            provider=provider,
            model=model,
            opt_out=False,
            extra_warnings=(carry.note,) if carry.note else (),
            source=VOICE_SOURCE_NONE,
        )

    # ③ 兼容快照：迁移 009 之前的逐镜声音，只在人物资产没有音色时兜底
    if legacy_file_id:
        return await _legacy_snapshot_admission(
            db,
            shot_id=shot_id,
            legacy_file_id=legacy_file_id,
            provider=provider,
            model=model,
        )

    # ④ 都没有：如实说"未绑定"，不制造噪音
    return classify_audio_input(
        file_id="",
        url="",
        provider=provider,
        model=model,
        opt_out=False,
        source=VOICE_SOURCE_NONE,
    )


async def _legacy_snapshot_admission(
    db: AsyncSession,
    *,
    shot_id: str,
    legacy_file_id: str,
    provider: str,
    model: str | None,
) -> AudioAdmission:
    """兼容回退路径：用迁移前的逐镜声音快照，并**显式标注**它只是兼容快照。

    这条路径只在"这一镜的人物资产还没有绑音色"时才会走到。标注必须带上，
    否则用户会以为人物资产的音色没生效、又去找逐镜绑定的入口（那个入口已经不存在）。
    """
    from app.models.studio import FileItem
    from app.services.studio.bound_asset_files import resolve_shot_audio_file
    from app.utils.files import is_public_storage_key

    bound = await resolve_shot_audio_file(db, shot_id=shot_id)
    file_id = (str(getattr(bound, "file_id", "") or "") or legacy_file_id).strip()
    file_obj = await db.get(FileItem, file_id) if file_id else None
    storage_key = str(getattr(file_obj, "storage_key", "") or "").strip()
    url = storage_key if is_public_storage_key(storage_key) else str(getattr(bound, "url", "") or "")
    label = str(getattr(bound, "asset_name", "") or "") or file_id or "（未命名音频）"

    warnings = list(getattr(bound, "warnings", ()) or ()) if bound is not None else []
    warnings.append(
        "本镜当前用的是**迁移前留下的逐镜声音快照**（兼容口，只读）："
        "这一镜关联的人物资产还没有绑定音色。"
        "到第 2 步「人物资产详情」给人物绑定音色后，本镜下次生成会自动改用人物资产的音色，"
        "不需要逐镜修改。"
    )
    return classify_audio_input(
        file_id=file_id,
        url=url,
        provider=provider,
        model=model,
        label=label,
        opt_out=False,
        # ``files`` 表里查不到该 file_id 时，绑定解析会给出警示且不带 file_id
        file_found=file_obj is not None,
        extra_warnings=tuple(warnings),
        source=VOICE_SOURCE_LEGACY_SNAPSHOT,
    )


def plan_audio_state(admission: AudioAdmission) -> str:
    """把准入结论映射成计划里的 ``audio_state``（保留既有四个取值，前端已按它显示）。"""
    if admission.state == STATE_OPT_OUT:
        return "opt_out"
    if admission.state == STATE_NOT_BOUND:
        return "missing"
    return "bound" if admission.included else "bound_not_public"


async def attach_shot_audio_to_video_input(
    db: AsyncSession,
    *,
    shot_id: str,
    input_payload: dict[str, Any],
    provider: str,
    model: str | None,
) -> list[str]:
    """把该镜使用的角色声音接进 ``input_payload``（``audio_urls``），返回给用户看的提示列表。

    没有任何绑定声音时返回空列表（不制造噪音）；绑定了但不可携带时返回**明确原因**
    （来源就是 :func:`classify_audio_input` 的结论，不在这里另写判断）。

    官方协议的"最多 3 条"在这里与 ``apimart/video_payload.build_create_task_body`` 各自
    ``[:3]`` 截断（两处硬编码；能力值 ``max_audio_inputs`` 目前没被读 —— 收敛成一处是
    后续小改，本轮不动）。"总时长 ≤15s"与"需与参考图/参考视频一起用"两条**未强制**。
    """
    admission = await resolve_audio_admission(
        db, shot_id=shot_id, provider=provider, model=model
    )
    warnings: list[str] = list(admission.extra_warnings)

    if not admission.file_id:
        # 未绑定 / 明确无需声音：不制造噪音（与改动前一致）
        return warnings

    input_payload["audio_source_file_id"] = admission.file_id or None
    if admission.note:
        warnings.append(admission.note)

    if not admission.included:
        return warnings

    urls = [str(item).strip() for item in (input_payload.get("audio_urls") or []) if str(item).strip()]
    if admission.url not in urls:
        urls.append(admission.url)
    input_payload["audio_urls"] = urls[:3]

    conflicts = _audio_frame_conflicts(model=model, input_payload=input_payload)
    if conflicts:
        warnings.append(conflicts)
    return warnings


def _audio_frame_conflicts(*, model: str | None, input_payload: dict[str, Any]) -> str:
    """seedance 官方警告：使用首尾帧图片时参考音频不可用。这里只提示，不静默改写入参。"""
    from app.core.integrations.video_capabilities import resolve_video_capability

    cap = resolve_video_capability(provider="apimart", model=model)
    if not cap.audio_input_conflicts_with_frame_roles:
        return ""
    has_frames = bool(input_payload.get("first_frame_base64") or input_payload.get("last_frame_base64"))
    if not has_frames:
        return ""
    return (
        "注意：seedance 官方说明「使用首尾帧图片时参考音频不可用」（实测同时发 first_frame_image "
        "与 audio_urls 会被直接 400）。为避免这次注定被拒的请求，适配器已把首/尾帧**改以 "
        "image_urls 提交**（等同官方文档里的「图生视频（首帧）+ 参考音频」形式）；"
        "代价是尾帧不再是严格的结束帧。**注意**：这只保证请求能被接受，"
        "参考音频是否因此被采用、是否影响画面/口型，目前仍无真实证据。"
    )


async def describe_shot_audio_for_video(
    db: AsyncSession,
    *,
    shot_id: str,
    provider: str,
    model: str | None,
) -> str:
    """只读描述：这一镜**该用的角色声音**会不会进入本次视频生成请求。

    给计划预览用的**不花钱**说明；没有可用声音（或明确无需声音）时返回空串（不制造噪音）。
    """
    admission = await resolve_audio_admission(
        db, shot_id=shot_id, provider=provider, model=model
    )
    if not admission.file_id:
        return ""
    if admission.included:
        return admission.note
    return f"{admission.excluded_reason} {admission.how_to_fix}".strip()


__all__ = [
    "INCLUDED_STATES",
    "REFERENCE_AUDIO_TERMS_NOTE",
    "STATE_NOT_BOUND",
    "STATE_OPT_OUT",
    "VOICE_SOURCE_CHARACTER_ASSET",
    "VOICE_SOURCE_LEGACY_SNAPSHOT",
    "VOICE_SOURCE_NONE",
    "AudioAdmission",
    "AssetVoiceCarry",
    "attach_shot_audio_to_video_input",
    "classify_audio_input",
    "describe_shot_audio_for_video",
    "plan_audio_state",
    "resolve_asset_voice_for_shot",
    "resolve_audio_admission",
]
