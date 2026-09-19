"""编排层的确定性词表与白名单。

这些常量是"确定性后校验"的依据：模型只能在这个范围内选值，越界即被拦截并记 warning。
刻意不放进提示词模板里，避免"词表被当成提示词的一部分被模型改写"。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.models.types import PromptCategory

# --------------------------------------------------------------------------
# 实体类型白名单（4.1 实体提取）
# --------------------------------------------------------------------------

ENTITY_TYPE_WHITELIST: tuple[str, ...] = ("character", "scene", "prop")

ENTITY_TYPE_ALIASES: dict[str, str] = {
    "character": "character",
    "characters": "character",
    "char": "character",
    "role": "character",
    "actor": "character",
    "person": "character",
    "人物": "character",
    "角色": "character",
    "演员": "character",
    "scene": "scene",
    "scenes": "scene",
    "location": "scene",
    "place": "scene",
    "environment": "scene",
    "场景": "scene",
    "地点": "scene",
    "环境": "scene",
    "prop": "prop",
    "props": "prop",
    "item": "prop",
    "object": "prop",
    "道具": "prop",
    "物件": "prop",
    "costume": "costume",
    "costumes": "costume",
    "wardrobe": "costume",
    "服装": "costume",
    "服饰": "costume",
}

# 实体提取只接受 character/scene/prop；服装在 Jellyfish 里是独立资产，
# 但属于"不自动建资产"的边界外类型，这里显式记录以便给出可解释的 warning。
ENTITY_TYPE_REJECT_HINTS: dict[str, str] = {
    "costume": "服装属于独立资产类型，实体提取阶段不作为草稿类型返回（可后续人工创建）",
}


def normalize_entity_type(raw: object) -> str | None:
    """把模型给的类型归一化；不在白名单内返回 None。"""
    text = str(raw or "").strip().lower()
    if not text:
        return None
    if text in ENTITY_TYPE_ALIASES:
        return ENTITY_TYPE_ALIASES[text]
    return None


# --------------------------------------------------------------------------
# 图片提示词槽位（4.2）
# --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ImagePromptSlotSpec:
    category: PromptCategory
    label: str
    entity_type: str | None
    view_hint: str
    subject_source: str


IMAGE_PROMPT_SLOT_SPECS: tuple[ImagePromptSlotSpec, ...] = (
    ImagePromptSlotSpec(
        category=PromptCategory.character_image_front,
        label="角色正面图片",
        entity_type="character",
        view_hint="正面全身参考图",
        subject_source="角色画像卡",
    ),
    ImagePromptSlotSpec(
        category=PromptCategory.character_image_other,
        label="角色侧面/背面图片",
        entity_type="character",
        view_hint="侧面与背面视角保持同一人同一造型",
        subject_source="角色画像卡",
    ),
    ImagePromptSlotSpec(
        category=PromptCategory.scene_image_front,
        label="场景正面图片",
        entity_type="scene",
        view_hint="广角建立镜头，空间结构清晰",
        subject_source="场景画像卡",
    ),
    ImagePromptSlotSpec(
        category=PromptCategory.scene_image_other,
        label="场景侧面/背面图片",
        entity_type="scene",
        view_hint="同场景另一视角，保持建筑与陈设一致",
        subject_source="场景画像卡",
    ),
    ImagePromptSlotSpec(
        category=PromptCategory.costume_image_front,
        label="服装正面图片",
        entity_type="costume",
        view_hint="服装正面平铺或立架展示",
        subject_source="服装画像卡",
    ),
    ImagePromptSlotSpec(
        category=PromptCategory.costume_image_other,
        label="服装侧面/背面图片",
        entity_type="costume",
        view_hint="同套服装侧面/背面细节",
        subject_source="服装画像卡",
    ),
    ImagePromptSlotSpec(
        category=PromptCategory.frame_head_image,
        label="首帧图片",
        entity_type=None,
        view_hint="按镜头内容定景别，作为视频首帧",
        subject_source="镜头文本",
    ),
    ImagePromptSlotSpec(
        category=PromptCategory.frame_tail_image,
        label="尾帧图片",
        entity_type=None,
        view_hint="承接首帧，动作推进后的落点状态",
        subject_source="镜头文本",
    ),
    ImagePromptSlotSpec(
        category=PromptCategory.frame_key_image,
        label="关键帧图片",
        entity_type=None,
        view_hint="情绪/动作爆发点的单帧",
        subject_source="镜头文本",
    ),
)

DEFAULT_IMAGE_PROMPT_CATEGORIES: tuple[PromptCategory, ...] = tuple(
    spec.category for spec in IMAGE_PROMPT_SLOT_SPECS
)

IMAGE_PROMPT_SLOT_BY_CATEGORY: dict[str, ImagePromptSlotSpec] = {
    str(spec.category.value): spec for spec in IMAGE_PROMPT_SLOT_SPECS
}


def image_prompt_slot_specs() -> list[dict[str, Any]]:
    """九槽位定义的可序列化形式（只读，供前端渲染「手工填写提示词」表单）。

    DRY_RUN 下真实大模型被守卫挡住，用户仍然需要一条能把**自己写的**提示词保存到
    ``<entities>.image_prompts`` 的路；前端不应该靠硬编码槽位名来实现它。
    """
    return [
        {
            "category": str(spec.category.value),
            "label": spec.label,
            "entity_type": spec.entity_type,
            "view_hint": spec.view_hint,
            "subject_source": spec.subject_source,
        }
        for spec in IMAGE_PROMPT_SLOT_SPECS
    ]

# 分层结构顺序：主体描述 + 动作姿态 + 场景环境 + 镜头语言 + 风格 + 画质词
IMAGE_PROMPT_LAYER_ORDER: tuple[str, ...] = (
    "subject",
    "action_pose",
    "environment",
    "camera_language",
    "style",
    "quality",
)

IMAGE_PROMPT_LAYER_LABELS: dict[str, str] = {
    "subject": "主体描述",
    "action_pose": "动作姿态",
    "environment": "场景环境",
    "camera_language": "镜头语言",
    "style": "风格",
    "quality": "画质词",
}

# 中控台 llm_client.py 里的画质/负面词规则，迁到这里作为确定性兜底。
DEFAULT_QUALITY_WORDS = (
    "photorealistic, cinematic lighting, sharp focus, detailed skin texture, "
    "high consistency reference image"
)

DEFAULT_STYLE_WORDS = "realistic live-action short drama style, real human actor"

DEFAULT_NEGATIVE_PROMPT = (
    "3D, CGI, cartoon, anime, illustration, game character, doll-like face, plastic skin, "
    "low quality, blurry, distorted hands, extra fingers, deformed body, bad anatomy, "
    "text, watermark, logo, subtitles"
)

# 每个槽位的画质/风格补充（沿用中控台 ASSET_PROFILE 的"必须逐字包含"规则）。
SLOT_STYLE_RULES: dict[str, tuple[str, ...]] = {
    "character_image_front": ("full body character reference sheet", "clean white background"),
    "character_image_other": ("full body character reference sheet", "clean white background"),
    "scene_image_front": ("cinematic live-action environment", "wide establishing shot", "empty scene, no people"),
    "scene_image_other": ("cinematic live-action environment", "empty scene, no people"),
    "costume_image_front": ("isolated costume reference", "flat lay or mannequin display"),
    "costume_image_other": ("isolated costume reference", "back and side detail"),
    "frame_head_image": ("cinematic still frame", "consistent character identity"),
    "frame_tail_image": ("cinematic still frame", "consistent character identity"),
    "frame_key_image": ("cinematic still frame", "peak emotion moment"),
}

SLOT_NEGATIVE_EXTRA: dict[str, tuple[str, ...]] = {
    "character_image_front": ("half body", "cropped body", "exaggerated pose", "multiple people"),
    "character_image_other": ("half body", "cropped body", "exaggerated pose", "multiple people"),
    "scene_image_front": ("isolated object", "product photo", "floating object", "white background"),
    "scene_image_other": ("isolated object", "product photo", "white background"),
}


# --------------------------------------------------------------------------
# 运镜词标准词库（4.3）
# --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CameraMovementSpec:
    """一个标准运镜词。

    ``enum_code`` 对应 ``app.models.types.CameraMovement``；为 None 表示标准词库里
    有、但 DB 枚举没有对应值（写回 shots 时需要人工选择，见 ``db_note``）。
    """

    key: str
    zh: str
    en: str
    enum_code: str | None
    aliases: tuple[str, ...]
    db_note: str = ""


CAMERA_MOVEMENT_SPECS: tuple[CameraMovementSpec, ...] = (
    CameraMovementSpec(
        key="固定",
        zh="固定镜头",
        en="static locked-off camera",
        enum_code="STATIC",
        aliases=("固定", "静止", "定格", "static", "fixed", "locked", "STATIC", "固定镜头", "静止镜头"),
    ),
    CameraMovementSpec(
        key="推",
        zh="推镜（缓慢推近）",
        en="slow dolly in / push in",
        enum_code="DOLLY_IN",
        aliases=("推", "推镜", "推近", "推进", "缓慢推进", "dolly_in", "dolly in", "push in", "DOLLY_IN", "zoom in"),
    ),
    CameraMovementSpec(
        key="拉",
        zh="拉镜（缓慢拉远）",
        en="slow dolly out / pull back",
        enum_code="DOLLY_OUT",
        aliases=("拉", "拉镜", "拉远", "后拉", "dolly_out", "dolly out", "pull back", "DOLLY_OUT", "zoom out"),
    ),
    CameraMovementSpec(
        key="摇",
        zh="摇镜（左右横摇）",
        en="pan",
        enum_code="PAN",
        aliases=("摇", "摇镜", "横摇", "平摇", "pan", "PAN", "摇摄"),
    ),
    CameraMovementSpec(
        key="上下摇",
        zh="上下摇镜（俯仰）",
        en="tilt",
        enum_code="TILT",
        aliases=("上下摇", "俯仰", "抬头摇", "tilt", "TILT"),
    ),
    CameraMovementSpec(
        key="移",
        zh="移镜（横向移动）",
        en="tracking slide",
        enum_code="TRACK",
        aliases=("移", "移镜", "横移", "平移", "侧移", "移动", "track", "TRACK", "slider"),
    ),
    CameraMovementSpec(
        key="跟",
        zh="跟镜（跟随主体）",
        en="follow shot",
        enum_code="TRACK",
        aliases=("跟", "跟镜", "跟拍", "跟随", "跟随拍摄", "follow", "follow shot", "tracking shot"),
        db_note="DB 枚举无独立 FOLLOW，写回 shots.camera_movement 时用 TRACK 表达。",
    ),
    CameraMovementSpec(
        key="环绕",
        zh="环绕运镜",
        en="orbit around subject",
        enum_code=None,
        aliases=("环绕", "绕拍", "环绕运镜", "orbit", "orbit shot", "arc shot", "围绕"),
        db_note="DB 枚举 CameraMovement 无 ORBIT，写回 shots 前需人工确认。",
    ),
)

CAMERA_MOVEMENT_KEYS: tuple[str, ...] = tuple(spec.key for spec in CAMERA_MOVEMENT_SPECS)

_CAMERA_LOOKUP: dict[str, CameraMovementSpec] = {}


def _register_camera_aliases() -> None:
    for spec in CAMERA_MOVEMENT_SPECS:
        for alias in (spec.key, spec.zh, spec.en, *spec.aliases):
            key = str(alias or "").strip().lower()
            if key:
                _CAMERA_LOOKUP.setdefault(key, spec)


_register_camera_aliases()


def normalize_camera_movement(raw: object) -> CameraMovementSpec | None:
    """把模型/用户给的运镜词归一化到标准词库；不在词库内返回 None。"""
    text = str(raw or "").strip().lower()
    if not text:
        return None
    if text in _CAMERA_LOOKUP:
        return _CAMERA_LOOKUP[text]
    # 容忍"缓慢推近（push in）"这类复合写法：逐个标准词做包含匹配。
    for spec in CAMERA_MOVEMENT_SPECS:
        if spec.key in text or spec.zh in text:
            return spec
    return None


def camera_movement_options() -> list[dict[str, object]]:
    """给前端/文档用的标准运镜词清单。"""
    return [
        {
            "key": spec.key,
            "label": spec.zh,
            "en": spec.en,
            "enum_code": spec.enum_code,
            "db_note": spec.db_note,
        }
        for spec in CAMERA_MOVEMENT_SPECS
    ]


# --------------------------------------------------------------------------
# 视频提示词槽位（4.3）
# --------------------------------------------------------------------------

VIDEO_PROMPT_LAYER_ORDER: tuple[str, ...] = (
    "subject_action",
    "camera_movement",
    "expression_mood",
    "duration",
)

VIDEO_PROMPT_LAYER_LABELS: dict[str, str] = {
    "subject_action": "主体动作",
    "camera_movement": "运镜",
    "expression_mood": "表情/氛围",
    "duration": "时长",
}

ALLOWED_DURATION_SECONDS: tuple[int, ...] = (4, 5, 8, 10, 12, 15)

FRAME_MODES: tuple[str, ...] = ("single_frame", "first_last_frame")

CREATIVE_ENTITY_PROFILE_TEMPLATE = "画像卡：{name}（{entity_type}）｜{profile}"
