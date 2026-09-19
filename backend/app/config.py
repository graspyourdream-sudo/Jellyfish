"""应用配置，从环境变量加载。"""

import json
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


BACKEND_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = BACKEND_ROOT / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # App
    app_name: str = "Jellyfish API"
    debug: bool = False

    # API
    api_v1_prefix: str = "/api/v1"

    # Database
    database_url: str = "sqlite+aiosqlite:///./jellyfish.db"

    # Redis / Celery Broker
    redis_host: str = "localhost"
    redis_port: int = 6379
    redis_db: int = 0
    redis_password: str | None = None
    celery_broker_url: str | None = None

    # CORS：环境变量中建议使用逗号分隔（更贴近 docker-compose 用法）
    # 也兼容 JSON 数组：'["http://a","http://b"]'
    #
    # 7788 是前端 `npm run build` 后的 preview 端口；
    # 5173 是 `vite dev` 的端口（本地开发默认走这个）。
    # 少了 5173 会让浏览器把 POST/PATCH 的 OPTIONS 预检判成 400，
    # 表现为「新建项目失败」这类只在写操作上出现的报错。
    cors_origins: str = (
        "http://localhost:7788,http://127.0.0.1:7788,"
        "http://localhost:5173,http://127.0.0.1:5173"
    )

    @property
    def cors_origins_list(self) -> list[str]:
        s = (self.cors_origins or "").strip()
        if not s:
            return []
        if s.startswith("["):
            loaded = json.loads(s)
            if isinstance(loaded, list):
                return [str(x).strip() for x in loaded if str(x).strip()]
            return []
        return [x.strip() for x in s.split(",") if x.strip()]

    # S3 / 对象存储（用于素材文件）
    s3_endpoint_url: str | None = None
    s3_region_name: str | None = None
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    s3_bucket_name: str | None = None
    # 可选：统一前缀，方便按环境/项目隔离，如 "jellyfish/dev"
    s3_base_path: str = ""
    # 可选：对外访问基址（CDN 或自定义域名），为空则使用 S3 自带 URL 或预签名 URL
    s3_public_base_url: str | None = None

    # 文件存储驱动：
    # - "auto"（默认）：配了 s3_bucket_name 就走 S3，否则落到本地磁盘；
    # - "s3"：强制 S3；
    # - "local"：强制本地磁盘。
    # 本地磁盘模式是为了「单机开箱可用」：不配任何云存储也能把出图/出视频的
    # 结果存下来并通过 /files 路由回放。
    storage_driver: str = "auto"
    # 本地磁盘存储根目录（相对 backend 根目录，或绝对路径）
    local_storage_root: str = "storage"
    # 本地文件的对外基址；留空则返回相对路径 /files/{key}
    local_storage_base_url: str = ""

    def model_post_init(self, __context: object) -> None:
        if not self.celery_broker_url or not str(self.celery_broker_url).strip():
            password_part = f":{self.redis_password}@" if self.redis_password else ""
            self.celery_broker_url = f"redis://{password_part}{self.redis_host}:{self.redis_port}/{self.redis_db}"


settings = Settings()
