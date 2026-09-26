"""纯文本文档解析（TXT / MD / DOCX → 纯文本）。

做什么
======
把一份「剧本 / 商品资料」文件的字节内容变成纯文本：TXT / MD 按常见编码兜底解码，
DOCX 用**标准库**解析（DOCX 就是一个 zip，正文在 ``word/document.xml``），
旧版 ``.doc`` 与其它类型明确拒绝并给出可操作的中文提示。

为什么单独一个模块（而不是留在路由层）
====================================
两个入口要用**同一套**解析规则，写两套必然长歪：

1. ``POST /api/v1/studio/documents/parse``（用户导入剧本，见
   ``app/api/v1/routes/studio/documents.py``）；
2. 「商品资料提取」：``source_type=upload`` 的 TXT / DOCX 商品资料要解析出正文
   （见 ``app/services/studio/product_extraction.py``）。

服务层反向 import 路由层是倒挂，所以把纯函数抽到这里。本模块的边界：
**只依赖标准库与 ``fastapi.HTTPException``；不碰数据库、不碰对象存储、不落盘、不识图**。
"""

from __future__ import annotations

import io
import zipfile
from xml.etree import ElementTree

from fastapi import HTTPException, status

#: 单次解析的大小上限（剧本/商品资料文件足够大，但不接受超大文件把内存打满）。
MAX_DOCUMENT_BYTES = 5 * 1024 * 1024

#: DOCX 里正文所在的位置。
DOCX_DOCUMENT_XML = "word/document.xml"

#: WordprocessingML 命名空间。
_W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

TEXT_EXTENSIONS = {"txt", "md", "markdown"}
DOCX_EXTENSIONS = {"docx"}
LEGACY_DOC_EXTENSIONS = {"doc"}

LEGACY_DOC_HINT = "旧版 .doc（二进制格式）无法可靠解析，请在 Word / WPS 里「另存为 DOCX」后重新导入。"
UNSUPPORTED_HINT = "暂不支持该文件类型；请导入 TXT、MD 或 DOCX 文件。"

EMPTY_FILE_HINT = "文件内容为空，请检查后重试。"


def extension(filename: str) -> str:
    """取小写扩展名（没有扩展名返回空串）。"""
    name = (filename or "").strip().lower()
    _, _, tail = name.rpartition(".")
    return tail if tail and tail != name else ""


def decode_text(raw: bytes) -> tuple[str, list[str]]:
    """按常见编码尝试解码，返回 ``(文本, 告警)``。

    为什么要有编码兜底：中文剧本 / 商品资料常见 GB18030 编码，直接按 UTF-8 读会失败或乱码。
    """
    warnings: list[str] = []
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            text = raw.decode(encoding)
        except UnicodeDecodeError:
            continue
        if encoding != "utf-8-sig":
            warnings.append(f"文件按 {encoding} 解码（不是 UTF-8），如有乱码请另存为 UTF-8 后重试。")
        return text, warnings
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="无法识别文件编码（已尝试 UTF-8 / GB18030）。请另存为 UTF-8 编码的 TXT 后重试。",
    )


def extract_docx_text(raw: bytes) -> str:
    """从 DOCX 字节里取正文纯文本（标准库实现，无第三方依赖）。"""
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            if DOCX_DOCUMENT_XML not in archive.namelist():
                raise KeyError(DOCX_DOCUMENT_XML)
            xml_bytes = archive.read(DOCX_DOCUMENT_XML)
    except (zipfile.BadZipFile, KeyError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "文件不是有效的 DOCX（无法作为 zip 打开或缺少 word/document.xml）。"
                "如果它其实是老版 .doc，请另存为 DOCX 后重试。"
            ),
        ) from exc

    try:
        root = ElementTree.fromstring(xml_bytes)
    except ElementTree.ParseError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="DOCX 正文 XML 解析失败，文件可能已损坏。",
        ) from exc

    paragraphs: list[str] = []
    for paragraph in root.iter(f"{_W_NS}p"):
        pieces: list[str] = []
        for node in paragraph.iter():
            if node.tag == f"{_W_NS}t" and node.text:
                pieces.append(node.text)
            elif node.tag == f"{_W_NS}tab":
                pieces.append("\t")
            elif node.tag == f"{_W_NS}br":
                pieces.append("\n")
        paragraphs.append("".join(pieces))
    # 段落之间用换行分隔；结尾去掉多余空行，保持与「粘贴文本」一致的形态。
    return "\n".join(paragraphs).strip("\n")


def extract_plain_text(raw: bytes, *, filename: str) -> tuple[str, str, list[str]]:
    """文件字节 → ``(归一化后的纯文本, 格式标识, 告警)``。

    校验顺序与提示口径与 ``POST /studio/documents/parse`` 完全一致（空文件 400、
    超限 413、旧版 .doc 400、不支持的后缀 400），保证两个入口给出的中文解释一样。
    解析失败抛 ``HTTPException``（调用方决定是原样抛出还是降级成一条告警）。
    """
    if len(raw) == 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=EMPTY_FILE_HINT)
    if len(raw) > MAX_DOCUMENT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"文件超过 {MAX_DOCUMENT_BYTES // (1024 * 1024)} MB 上限，请拆分后再导入。",
        )

    ext = extension(filename)
    warnings: list[str] = []

    if ext in LEGACY_DOC_EXTENSIONS:
        # 明确提示，不静默失败、不返回空文本。
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=LEGACY_DOC_HINT)
    if ext in TEXT_EXTENSIONS:
        text, decode_warnings = decode_text(raw)
        warnings.extend(decode_warnings)
        fmt = "md" if ext in {"md", "markdown"} else "txt"
    elif ext in DOCX_EXTENSIONS:
        text = extract_docx_text(raw)
        fmt = "docx"
        if not text.strip():
            warnings.append("DOCX 里没有解析到任何文字：如果正文在文本框/图片里，请改为粘贴文本。")
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=UNSUPPORTED_HINT)

    # 换行归一化 + 去掉首尾空行：粘贴进章节/商品卡的内容不该带一串空行（DOCX 分支同样处理）
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip("\n")
    return text, fmt, warnings


__all__ = [
    "DOCX_DOCUMENT_XML",
    "DOCX_EXTENSIONS",
    "EMPTY_FILE_HINT",
    "LEGACY_DOC_EXTENSIONS",
    "LEGACY_DOC_HINT",
    "MAX_DOCUMENT_BYTES",
    "TEXT_EXTENSIONS",
    "UNSUPPORTED_HINT",
    "decode_text",
    "extension",
    "extract_docx_text",
    "extract_plain_text",
]
