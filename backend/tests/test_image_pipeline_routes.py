"""P3 路由层：挂载、统一信封、DRY_RUN 不触网、契约校验（costume 不在出图服务契约内）。"""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

BASE = "/api/v1/studio/image-pipeline"

STATUS_URL = f"{BASE}/status"
PLAN_URL = f"{BASE}/plan/preview"
SUBMIT_URL = f"{BASE}/submit"
TASK_URL = f"{BASE}/task/{{service_task_id}}"
VIDEO_PLAN_URL = f"{BASE}/video-plan/preview"
VIDEO_SUBMIT_URL = f"{BASE}/video-submit"
PACKAGE_URL = f"{BASE}/prompt-package"


@pytest.fixture(autouse=True)
def _force_dry_run(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JELLYFISH_DRY_RUN", "1")
    monkeypatch.delenv("JELLYFISH_REAL_LLM_CONFIRMED", raising=False)


def test_all_image_pipeline_routes_are_registered(client: TestClient) -> None:
    from app.main import app

    paths = {route.path for route in app.routes if hasattr(route, "path")}
    for path in (
        STATUS_URL,
        PLAN_URL,
        SUBMIT_URL,
        TASK_URL,
        VIDEO_PLAN_URL,
        VIDEO_SUBMIT_URL,
        PACKAGE_URL,
    ):
        assert path in paths, f"路由未挂载：{path}"


def test_status_route_never_probes_under_dry_run(client: TestClient) -> None:
    response = client.get(STATUS_URL)

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["guard"]["dry_run"] is True
    assert data["guard"]["real_call_confirmed"] is False
    assert set(data["guard"]["outlets"]) == {"llm", "image", "video", "oss"}
    # DRY_RUN 下不探测出图服务
    assert data["probe"] is None
    assert "DRY_RUN" in data["probe_skipped_reason"]
    assert data["service_asset_types"] == ["character", "scene", "prop"]
    assert data["generation_types"]["character"] == "character_sheet"


def test_plan_preview_rejects_costume_out_of_contract(client: TestClient) -> None:
    response = client.post(
        PLAN_URL,
        json={"project_id": "proj-1", "asset_type": "costume", "stage": "character_sheet"},
    )

    assert response.status_code == 400
    body = response.json()
    assert body["code"] == 400
    assert body["data"] is None
    assert "只支持 asset_type" in body["meta"]["error"]["message"]


def test_submit_returns_structured_error_for_out_of_contract_asset(client: TestClient) -> None:
    response = client.post(
        SUBMIT_URL,
        json={"project_id": "proj-1", "asset_type": "costume", "stage": "reference_batch"},
    )

    assert response.status_code == 400
    assert isinstance(response.json()["meta"]["error"], dict)


def test_task_query_under_dry_run_does_not_reach_service(client: TestClient) -> None:
    response = client.get(f"{BASE}/task/svc-does-not-exist")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["dry_run"] is True
    assert data["status"] == "dry_run"
    assert "未创建任何出图任务" in data["error_message"]


def test_prompt_package_returns_404_envelope_for_unknown_project(client: TestClient) -> None:
    response = client.post(PACKAGE_URL, json={"project_id": "project-that-does-not-exist"})

    assert response.status_code == 404
    body = response.json()
    assert body["code"] == 404
    assert body["data"] is None
    assert body["meta"]["error"]["message"]


def test_video_plan_returns_404_envelope_for_unknown_shot(client: TestClient) -> None:
    response = client.post(VIDEO_PLAN_URL, json={"shot_id": "shot-does-not-exist"})

    assert response.status_code == 404
    body = response.json()
    assert body["code"] == 404
    assert body["meta"]["error"]["message"]


def test_video_submit_never_reaches_provider(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """无论 DB 里有没有配视频模型，DRY_RUN 下都不能出现真实 provider 调用。"""
    calls: list[str] = []

    async def _forbidden(self, method, url, *args, **kwargs):  # type: ignore[no-untyped-def]
        calls.append(str(url))
        raise AssertionError(f"DRY_RUN 下不允许出站：{url}")

    monkeypatch.setattr(httpx.AsyncClient, "request", _forbidden, raising=True)

    response = client.post(VIDEO_SUBMIT_URL, json={"shot_id": "shot-does-not-exist", "ratio": "16:9"})

    assert calls == []
    if response.status_code == 200:
        # 计划阶段成功但提交被守卫挡住
        assert response.json()["data"]["status"] == "dry_run"
        assert response.json()["data"]["url"] == ""
    else:
        # 计划阶段就先失败了（例如没配视频模型 / 镜头不存在），同样没触网
        assert response.json()["meta"]["error"]


def test_dry_run_image_routes_never_touch_network(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hits: list[str] = []

    async def _forbidden(self, method, url, *args, **kwargs):  # type: ignore[no-untyped-def]
        hits.append(str(url))
        raise AssertionError(f"DRY_RUN 下不允许出站：{url}")

    monkeypatch.setattr(httpx.AsyncClient, "request", _forbidden, raising=True)

    assert client.get(STATUS_URL).status_code == 200
    assert client.get(f"{BASE}/task/svc-1").status_code == 200
    assert client.post(PLAN_URL, json={"project_id": "p", "asset_type": "costume"}).status_code == 400
    assert client.post(SUBMIT_URL, json={"project_id": "p", "asset_type": "costume"}).status_code == 400
    assert client.post(PACKAGE_URL, json={"project_id": "project-missing"}).status_code == 404
    assert client.post(VIDEO_PLAN_URL, json={"shot_id": "shot-missing"}).status_code == 404

    assert hits == []


def test_openapi_schema_generates_for_image_pipeline() -> None:
    from app.main import app

    spec = app.openapi()
    assert f"{BASE}/submit" in spec["paths"]
    assert "post" in spec["paths"][f"{BASE}/submit"]
