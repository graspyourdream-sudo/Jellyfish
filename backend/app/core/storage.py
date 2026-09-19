"""统一的对象存储封装。

两种驱动，同一套接口：
- S3 兼容（boto3）：配置了 ``s3_bucket_name`` 时使用；
- 本地磁盘：没有任何云存储配置时的兜底，文件落在 ``local_storage_root`` 下，
  通过 ``/files/{key}`` 路由回放。

为什么需要本地磁盘：单机跑的时候，出图 / 出视频的结果必须落下来才有意义，
而要求每个本地用户先准备一套 S3 是过高的门槛。``STORAGE_DRIVER=auto`` 会
按配置自动选驱动。

设计目标：
- 提供上传 / 下载 / 列表 / 详情 等基础能力；
- 尽量不绑定具体云厂商，只依赖 S3 兼容协议；
- 在 FastAPI 异步环境下，避免阻塞事件循环：boto3 与文件 IO 都走线程池。
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO

from anyio import to_thread
import boto3
from botocore.client import Config as BotoConfig
from botocore.exceptions import ClientError

from app.config import BACKEND_ROOT, settings


@dataclass
class StoredFileInfo:
    """文件基础信息（供调用方在路由层自行封装为 Pydantic schema）。"""

    key: str
    url: str
    size: int | None = None
    content_type: str | None = None
    etag: str | None = None
    extra: dict[str, Any] | None = None


def _resolve_driver() -> str:
    """决定当前用哪个存储驱动。"""

    driver = (settings.storage_driver or "auto").strip().lower()
    if driver not in {"auto", "s3", "local"}:
        driver = "auto"
    if driver == "auto":
        return "s3" if settings.s3_bucket_name else "local"
    return driver


def is_local_storage() -> bool:
    return _resolve_driver() == "local"


def local_storage_path(key: str) -> Path:
    """把逻辑 key 映射到本地磁盘路径，并保证不会越出根目录。"""

    root = Path(settings.local_storage_root or "storage")
    if not root.is_absolute():
        root = BACKEND_ROOT / root
    root = root.resolve()
    target = (root / _normalize_key(key)).resolve()
    if root != target and root not in target.parents:
        raise ValueError(f"非法的存储 key（越出存储根目录）：{key}")
    return target


def _build_s3_client():
    if not settings.s3_bucket_name:
        raise RuntimeError("S3 未配置：请在配置中设置 s3_bucket_name 等必要字段")

    client = boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint_url,
        region_name=settings.s3_region_name,
        aws_access_key_id=settings.s3_access_key_id,
        aws_secret_access_key=settings.s3_secret_access_key,
        config=BotoConfig(
            s3={"addressing_style": "virtual"},
            # 兼容非 AWS 的 S3 实现（实测：阿里云 OSS）：
            # botocore 新版默认对 PutObject 启用 aws-chunked 校验算法，会发
            # ``STREAMING-UNSIGNED-PAYLOAD-TRAILER``；OSS 对该模式直接返回
            # ``400 NotImplemented: Aws MultiChunkedEncoding STREAMING-UNSIGNED-PAYLOAD-TRAILER
            # is not supported.`` —— 这不是权限问题（同一请求去掉该默认即 200）。
            # ``when_required`` 是 AWS 对第三方 S3 兼容服务推荐的取值，对 AWS 自身无副作用。
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        ),
    )
    return client


def _normalize_key(key: str) -> str:
    key = key.lstrip("/")
    base = settings.s3_base_path.strip().strip("/")
    if base:
        return f"{base}/{key}"
    return key


def public_url_for_key(key: str) -> str:
    """S3 驱动且**显式**配置了公网基址时，返回该对象的公网地址；否则返回空串。

    为什么需要它：``files.storage_key`` 存的是**逻辑 key**（例如
    ``generated-images/shot_frame_image/12/xxx.png``），而 S3 驱动下对象实际落在
    ``{s3_base_path}/{key}``，公网地址是 ``{s3_public_base_url}/{s3_base_path}/{key}``。
    参考帧可用性判定如果只看相对 key，就会把它当成"本机文件"→ 转 data URL →
    判为供应商不可用；可对象其实已经公网可读（实测匿名 200）。这里给出**唯一**的构造口径。

    硬约束：**不使用** path-style 回退（``{endpoint}/{bucket}/{key}``）—— 在多数云厂商
    （如阿里云 OSS）上那是错的地址；没有 ``s3_public_base_url`` 就返回空串，让调用方
    继续走原来的 data URL 分支。
    """
    if is_local_storage():
        return ""
    base = (settings.s3_public_base_url or "").strip()
    if not base or not settings.s3_bucket_name:
        return ""
    return f"{base.rstrip('/')}/{_normalize_key(key)}"


def _build_public_url(key: str) -> str:
    key = _normalize_key(key)
    if is_local_storage():
        base = (settings.local_storage_base_url or "").rstrip("/")
        return f"{base}/files/{key}" if base else f"/files/{key}"
    if settings.s3_public_base_url:
        base = settings.s3_public_base_url.rstrip("/")
        return f"{base}/{key}"
    # fallback：使用标准 S3 URL 形式；具体可根据实际厂商调整
    if not settings.s3_bucket_name:
        raise RuntimeError("S3 未配置：缺少 s3_bucket_name")
    endpoint = settings.s3_endpoint_url.rstrip("/") if settings.s3_endpoint_url else ""
    if endpoint:
        return f"{endpoint}/{settings.s3_bucket_name}/{key}"
    # 若未配置 endpoint，则退回最基础的 path 形式
    return f"/{settings.s3_bucket_name}/{key}"


def init_storage() -> None:
    """初始化存储。

    说明：
    - S3：bucket 已存在则直接返回；无权限/配置错误会抛异常，便于部署时尽早失败；
    - 本地磁盘：建好根目录即可；
    - 对于部分 S3 兼容服务（MinIO 等），CreateBucket 的参数可能不同，这里尽量兼容常见情形。
    """

    if is_local_storage():
        local_storage_path("").mkdir(parents=True, exist_ok=True)
        return

    client = _build_s3_client()
    bucket = settings.s3_bucket_name
    if not bucket:
        raise RuntimeError("S3 未配置：缺少 s3_bucket_name")

    try:
        client.head_bucket(Bucket=bucket)
        return
    except ClientError as e:
        code = str(e.response.get("Error", {}).get("Code", ""))
        # 常见不存在：404 / NoSuchBucket / NotFound
        if code not in {"404", "NoSuchBucket", "NotFound"}:
            raise

    params: dict[str, Any] = {"Bucket": bucket}
    region = settings.s3_region_name
    # AWS S3 在 us-east-1 不需要 LocationConstraint，其他 region 需要
    if region and region != "us-east-1":
        params["CreateBucketConfiguration"] = {"LocationConstraint": region}

    try:
        client.create_bucket(**params)
    except ClientError as e:
        # 可能出现并发创建或服务端返回已存在
        code = str(e.response.get("Error", {}).get("Code", ""))
        if code in {"BucketAlreadyOwnedByYou", "BucketAlreadyExists"}:
            return
        raise

    # 再次确认 bucket 可用
    client.head_bucket(Bucket=bucket)


async def upload_file(
    *,
    key: str,
    data: bytes | BinaryIO,
    content_type: str | None = None,
    extra_args: dict[str, Any] | None = None,
) -> StoredFileInfo:
    """上传文件。

    参数：
    - key：逻辑 key（不需要带 base_path，会自动拼接）；
    - data：字节内容或类文件对象；
    - content_type：MIME 类型，例如 image/png；
    - extra_args：透传给 boto3 的 ExtraArgs，如 {"ACL": "public-read"}；本地驱动忽略。
    """

    if is_local_storage():
        stored_key = _normalize_key(key)
        target = local_storage_path(key)
        payload = data if isinstance(data, (bytes, bytearray)) else data.read()
        payload = bytes(payload)

        def _write() -> None:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)

        await to_thread.run_sync(_write)
        return StoredFileInfo(
            key=stored_key,
            url=_build_public_url(key),
            size=len(payload),
            content_type=content_type,
        )

    client = _build_s3_client()
    bucket = settings.s3_bucket_name
    if bucket is None:
        raise RuntimeError("S3 未配置：缺少 s3_bucket_name")

    s3_key = _normalize_key(key)
    extra = extra_args.copy() if extra_args else {}
    if content_type and "ContentType" not in extra:
        extra["ContentType"] = content_type

    def _upload():
        if isinstance(data, (bytes, bytearray)):
            return client.put_object(Bucket=bucket, Key=s3_key, Body=data, **extra)
        return client.upload_fileobj(data, bucket, s3_key, ExtraArgs=extra)  # type: ignore[arg-type]

    result = await to_thread.run_sync(_upload)

    etag = None
    if isinstance(result, dict):
        etag = result.get("ETag")

    url = _build_public_url(key)
    return StoredFileInfo(key=s3_key, url=url, etag=etag)


async def download_file(*, key: str) -> bytes:
    """下载文件内容（整个对象读入内存）。"""

    if is_local_storage():
        target = local_storage_path(key)

        def _read() -> bytes:
            return target.read_bytes()

        return await to_thread.run_sync(_read)

    client = _build_s3_client()
    bucket = settings.s3_bucket_name
    if bucket is None:
        raise RuntimeError("S3 未配置：缺少 s3_bucket_name")

    s3_key = _normalize_key(key)

    def _download() -> bytes:
        obj = client.get_object(Bucket=bucket, Key=s3_key)
        body = obj["Body"].read()
        return body  # type: ignore[no-any-return]

    return await to_thread.run_sync(_download)


async def get_file_info(*, key: str) -> StoredFileInfo:
    """获取文件元信息（不下载内容）。"""

    if is_local_storage():
        stored_key = _normalize_key(key)
        target = local_storage_path(key)

        def _stat() -> int:
            return target.stat().st_size

        try:
            size = await to_thread.run_sync(_stat)
        except FileNotFoundError as exc:
            raise FileNotFoundError(f"文件不存在：{stored_key}") from exc
        return StoredFileInfo(key=stored_key, url=_build_public_url(key), size=size)

    client = _build_s3_client()
    bucket = settings.s3_bucket_name
    if bucket is None:
        raise RuntimeError("S3 未配置：缺少 s3_bucket_name")

    s3_key = _normalize_key(key)

    def _head() -> dict[str, Any]:
        return client.head_object(Bucket=bucket, Key=s3_key)  # type: ignore[no-any-return]

    meta = await to_thread.run_sync(_head)

    size = int(meta.get("ContentLength") or 0)
    content_type = meta.get("ContentType")
    etag = meta.get("ETag")

    url = _build_public_url(key)
    return StoredFileInfo(
        key=s3_key,
        url=url,
        size=size,
        content_type=content_type,
        etag=etag,
        extra={k: v for k, v in meta.items() if k not in {"ContentLength", "ContentType", "ETag"}},
    )


async def list_files(*, prefix: str = "") -> list[StoredFileInfo]:
    """根据前缀列出文件。"""

    if is_local_storage():
        stored_prefix = _normalize_key(prefix) if prefix else settings.s3_base_path.strip().strip("/")
        root = local_storage_path("")

        def _walk() -> list[StoredFileInfo]:
            if not root.exists():
                return []
            results: list[StoredFileInfo] = []
            for path in sorted(root.rglob("*")):
                if not path.is_file():
                    continue
                rel = path.relative_to(root).as_posix()
                if stored_prefix and not rel.startswith(stored_prefix):
                    continue
                results.append(
                    StoredFileInfo(key=rel, url=_build_public_url(rel), size=path.stat().st_size)
                )
            return results

        return await to_thread.run_sync(_walk)

    client = _build_s3_client()
    bucket = settings.s3_bucket_name
    if bucket is None:
        raise RuntimeError("S3 未配置：缺少 s3_bucket_name")

    normalized_prefix = _normalize_key(prefix) if prefix else settings.s3_base_path.strip().strip("/")

    def _list() -> list[dict[str, Any]]:
        resp = client.list_objects_v2(Bucket=bucket, Prefix=normalized_prefix or None)
        return resp.get("Contents", [])  # type: ignore[no-any-return]

    contents = await to_thread.run_sync(_list)

    results: list[StoredFileInfo] = []
    for item in contents:
        key = item["Key"]
        size = int(item.get("Size") or 0)
        url = _build_public_url(key)
        results.append(
            StoredFileInfo(
                key=key,
                url=url,
                size=size,
                extra={"LastModified": item.get("LastModified"), "StorageClass": item.get("StorageClass")},
            )
        )
    return results


async def delete_file(*, key: str) -> None:
    """删除文件。"""

    if is_local_storage():
        target = local_storage_path(key)

        def _delete() -> None:
            if target.is_dir():
                shutil.rmtree(target, ignore_errors=True)
            elif target.exists():
                target.unlink()

        await to_thread.run_sync(_delete)
        return

    client = _build_s3_client()
    bucket = settings.s3_bucket_name
    if bucket is None:
        raise RuntimeError("S3 未配置：缺少 s3_bucket_name")

    s3_key = _normalize_key(key)

    def _delete() -> None:
        client.delete_object(Bucket=bucket, Key=s3_key)

    await to_thread.run_sync(_delete)

