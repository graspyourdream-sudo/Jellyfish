"""验收脚本的**自检**：演练模式下一次调用都不发；计划可预览；报告脱敏。

这一批用例本身也**不碰网络**：`--print-plan` 纯打印，演练模式下脚本会在
call 1 之前就 `aborted`，因此 `report["calls"]` 必然为空。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import acceptance_real_llm_run as runner  # noqa: E402


def test_max_calls_is_five() -> None:
    """授权上限就是 5：1 次整章分析 + 4 次逐资产图片提示词。"""
    assert runner.MAX_CALLS == 5
    assert len(runner.ASSET_SLOT_PLAN) == 4
    assert [slot for _kind, slot in runner.ASSET_SLOT_PLAN] == [
        "character_image_front",
        "character_image_front",
        "scene_image_front",
        "prop_image_front",
    ]


def test_print_plan_lists_exactly_five_calls_without_calling(capsys: pytest.CaptureFixture[str]) -> None:
    code = runner.main(
        [
            "--project-id",
            "acc",
            "--chapter-id",
            "acc-ep1",
            "--entity-names",
            "姜岁欢,秦老夫人,听雨轩,镶银匕首",
            "--print-plan",
        ]
    )
    assert code == 0
    out = capsys.readouterr().out
    assert "未执行" in out
    payload = json.loads(out[out.index("[\n") :])  # 跳过 "[验收]" 前缀，取真正的 JSON 数组
    assert len(payload) == 5
    assert payload[0]["path"] == "/api/v1/studio/chapters/acc-ep1/asset-profiles"
    assert payload[1]["body"]["chapter_id"] == "acc-ep1"
    assert payload[1]["body"]["entity_names"] == ["姜岁欢"]
    # 四条提示词是一次一个槽位 → 结果就是"四条提示词"，便于逐条比差异
    assert [item["body"]["categories"][0] for item in payload[1:]] == [
        "character_image_front",
        "character_image_front",
        "scene_image_front",
        "prop_image_front",
    ]


def test_runner_refuses_without_the_authorization_gate(tmp_path: Path) -> None:
    """没有 --confirm-authorized 硬闸门 → 一次都不发（防止误跑花钱）。"""
    out = tmp_path / "report.json"
    code = runner.main(
        ["--project-id", "acc", "--chapter-id", "acc-ep1", "--out", str(out), "--keep-real-mode"]
    )
    assert code == 1
    report = json.loads(out.read_text(encoding="utf-8"))
    assert report["result"] == "aborted"
    assert report["calls"] == []
    assert "--confirm-authorized" in report["abort_reason"]


def test_runner_aborts_without_any_call_when_not_in_real_mode(tmp_path: Path) -> None:
    """带闸门但**不是真实模式** → 同样一次调用都不发，报告如实写 aborted，且不改 .env。"""
    out = tmp_path / "report.json"
    code = runner.main(
        [
            "--project-id",
            "acc",
            "--chapter-id",
            "acc-ep1",
            "--out",
            str(out),
            "--confirm-authorized",
            "--keep-real-mode",  # 测试里绝不改 backend/.env
        ]
    )
    assert code == 1
    report = json.loads(out.read_text(encoding="utf-8"))
    assert report["result"] == "aborted"
    assert report["calls"] == [], "非真实模式必须一次都不发"
    assert "一次调用都不发" in report["abort_reason"]
    assert report["status_before"]["is_real_mode"] is False
    assert report["status_before"]["mode"] == "dry_run"
    assert "--keep-real-mode" in report["restore"]
    # 演练模式下四个出口都应当被拦
    assert report["status_before"]["outlet_states"]
    assert all(not item["allowed"] for item in report["status_before"]["outlet_states"].values())


def test_report_is_free_of_credentials_and_local_paths(tmp_path: Path) -> None:
    out = tmp_path / "report.json"
    runner.main(
        ["--project-id", "acc", "--chapter-id", "acc-ep1", "--out", str(out), "--keep-real-mode"]
    )
    blob = out.read_text(encoding="utf-8")
    lowered = blob.lower()
    for forbidden in ("api_key", "sk-", "authorization", "bearer ", "/users/", "\\users\\"):
        assert forbidden not in lowered, f"报告里出现了不该有的内容：{forbidden}"


def test_status_summary_only_keeps_safe_fields() -> None:
    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app)
    try:
        # 不用 ``with``：避免 lifespan 里的对象存储 HeadBucket 探测（真实出网）
        summary = runner._status(client)  # noqa: SLF001 - 自检脚本内部函数
    finally:
        client.close()
    assert summary["http_status"] == 200
    assert summary["mode"] in {"dry_run", "real"}
    assert isinstance(summary["outlet_states"], dict)
    assert set(summary["outlet_states"]) >= {"llm", "image", "video", "oss"}
    blob = json.dumps(summary, ensure_ascii=False).lower()
    assert "api_key" not in blob
