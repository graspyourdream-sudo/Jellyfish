"""剧本文档解析（TXT / MD / DOCX → 纯文本）。

产品背景：「从剧本开始」的项目需要把已有剧本文件导进章节，而不是只能手动粘贴。

设计要点：
1. **只解析、不落盘、不写库、不上传对象存储**。这是一个纯函数式的读取端点，
   因此不需要付费出口守卫（不会调用任何外部服务，也不产生费用）。
2. DOCX 用**标准库**解析（DOCX 就是一个 zip，正文在 `word/document.xml`），
   不引入新依赖：逐个 `<w:p>` 段落取 `<w:t>` 文本。
3. 旧版 `.doc` 是二进制复合文档，无法可靠解析 —— 明确返回 400 并提示
   「请另存为 DOCX」，绝不静默返回空文本。

解析实现已抽到 `app/services/studio/doc_text.py`（本路由只剩 HTTP 形状与响应组装）：
「商品资料提取」(`product_extraction`) 的上传分支要复用**同一套**规则（编码兜底、
DOCX 标准库解析、扩展名判定与中文提示）。服务层反向 import 路由层是倒挂，所以
纯函数放服务层；本模块按原样再导出既有常量/函数，保持模块级引用点不变。
"""

from __future__ import annotations

from fastapi import APIRouter, File, UploadFile

from app.schemas.common import ApiResponse, success_response
from app.schemas.studio.documents import DocumentParseRead
from app.services.studio.doc_text import (
    DOCX_DOCUMENT_XML,
    DOCX_EXTENSIONS,
    LEGACY_DOC_EXTENSIONS,
    LEGACY_DOC_HINT,
    MAX_DOCUMENT_BYTES,
    TEXT_EXTENSIONS,
    UNSUPPORTED_HINT,
    extract_docx_text,
    extract_plain_text,
)

router = APIRouter()

__all__ = [
    "DOCX_DOCUMENT_XML",
    "DOCX_EXTENSIONS",
    "LEGACY_DOC_EXTENSIONS",
    "LEGACY_DOC_HINT",
    "MAX_DOCUMENT_BYTES",
    "TEXT_EXTENSIONS",
    "UNSUPPORTED_HINT",
    "extract_docx_text",
    "extract_plain_text",
    "router",
]


@router.post(
    "/parse",
    response_model=ApiResponse[DocumentParseRead],
    summary="解析剧本文档（TXT / MD / DOCX）为纯文本",
)
async def parse_document(file: UploadFile = File(..., description="TXT / MD / DOCX 文件")) -> ApiResponse[DocumentParseRead]:
    """把上传的剧本文档解析成纯文本。

    只读取上传内容并解析，**不写库、不上传对象存储、不调用任何外部服务**。
    """
    raw = await file.read()
    filename = file.filename or "未命名文件"
    # 解析规则（空文件 400 / 超限 413 / .doc 400 / 后缀不支持 400 / 编码兜底 / DOCX）都在 doc_text 里，
    # 与「商品资料提取」的上传分支共用同一套口径。
    text, fmt, warnings = extract_plain_text(raw, filename=filename)
    return success_response(
        DocumentParseRead(
            filename=filename,
            format=fmt,
            text=text,
            char_count=len(text),
            paragraph_count=len([line for line in text.split("\n") if line.strip()]),
            warnings=warnings,
        )
    )
