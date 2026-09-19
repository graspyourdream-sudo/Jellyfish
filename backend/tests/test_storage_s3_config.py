"""S3 客户端构造参数的回归测试（2026-09-19 真实 OSS 预检暴露）。

背景：botocore 新版默认给 PutObject 启用 aws-chunked 校验算法，会发送
``STREAMING-UNSIGNED-PAYLOAD-TRAILER``。阿里云 OSS 对该模式不支持，直接返回

    400 NotImplemented: Aws MultiChunkedEncoding STREAMING-UNSIGNED-PAYLOAD-TRAILER is not supported.

而**不是**权限拒绝 —— 同一请求把校验算法设为 ``when_required`` 后即 200。
这条测试锁住 ``_build_s3_client()`` 的三个配置，避免以后被改回去：

1. ``request_checksum_calculation == "when_required"``
2. ``response_checksum_validation == "when_required"``
3. ``s3.addressing_style == "virtual"``（阿里云 OSS 桶域名形如 bucket.oss-<region>.aliyuncs.com，
   必须虚拟主机风格；path-style 会被 ``SecondLevelDomainForbidden`` 拒绝）

测试只构造 client 对象、不发任何网络请求，也不读取真实凭证（用 dummy 值 + 只读 settings 覆盖）。
"""

from __future__ import annotations

import pytest

from app.core import storage


@pytest.fixture
def _s3_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """把 S3 配置替换成 dummy 值：只为构造 client，不做任何 I/O。"""
    from app.config import settings

    monkeypatch.setattr(settings, "s3_bucket_name", "test-bucket", raising=False)
    monkeypatch.setattr(settings, "s3_endpoint_url", "https://oss-cn-beijing.aliyuncs.com", raising=False)
    monkeypatch.setattr(settings, "s3_region_name", "cn-beijing", raising=False)
    monkeypatch.setattr(settings, "s3_access_key_id", "dummy-key-id", raising=False)
    monkeypatch.setattr(settings, "s3_secret_access_key", "dummy-secret", raising=False)


def test_s3_client_uses_s3_compatible_checksum_and_virtual_addressing(_s3_settings: None) -> None:
    """三个关键配置必须同时成立（少一个都会让 OSS 上的上传/下载失败）。"""
    client = storage._build_s3_client()  # noqa: SLF001 - 直接验证构造结果
    config = client.meta.config

    assert config.request_checksum_calculation == "when_required"
    assert config.response_checksum_validation == "when_required"
    assert config.s3.get("addressing_style") == "virtual"


def test_s3_client_requires_bucket(monkeypatch: pytest.MonkeyPatch) -> None:
    """没配 bucket 时仍然明确报错（不要悄悄退化成默认值）。"""
    from app.config import settings

    monkeypatch.setattr(settings, "s3_bucket_name", None, raising=False)
    with pytest.raises(RuntimeError):
        storage._build_s3_client()  # noqa: SLF001


def test_local_storage_driver_needs_no_s3_client(monkeypatch: pytest.MonkeyPatch) -> None:
    """本地驱动分支不应受 S3 配置影响（保住"单机开箱可用"）。"""
    from app.config import settings

    monkeypatch.setattr(settings, "storage_driver", "local", raising=False)
    assert storage._resolve_driver() == "local"
    assert storage.is_local_storage() is True
