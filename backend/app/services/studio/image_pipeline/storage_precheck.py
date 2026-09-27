"""出图前的**免费存储预检**：存储不可用就别花钱出图。

为什么必须有（真实演练得出的结论）
==================================

2026-09-27 那次真实出图：出图服务**把图生成出来了**（已计费），但它自己上传 OSS 时被拒：

    OSS 上传返回 HTTP 403 AccessDenied … bucket acl

结果就是「钱花了、图取不回来」。而这件事在提交**之前**是能免费问出来的——
出图服务的 ``GET /api/service/health`` 是只读的，不花钱。

要点在于「**已配置 ≠ 可写**」：那次 ``oss.configured`` 是 **true**（环境变量齐全），
失败发生在**写入授权**。上游目前的健康检查只报「配没配」，不报「写不写得进去」，
所以本模块分三档，不把「配了」当成「能写」：

- ``writable``：上游明确回报可写 → 放行；
- ``configured_unverified``：配了、但上游**没有**回报可写性（当前上游的实际形态）→ **放行但明确告知**
  这个残留风险（不假装验过）；
- ``not_configured`` / ``not_writable``：上游给出了**明确的否定证据** → **拦下并给中文修法**，一个请求都不发；
- ``unreachable``（连不上/探不动）→ **降级放行并写进 warnings**：连不上时"创建任务"本身也会失败，
  不会真的花钱；而且这一层如果抢着报错，会把守卫该报的错（未确认/出口未授权）盖成"存储问题"。

「拦下」只用在**有明确否定证据**的时候：宁可如实说"没验过"，也不把"没探到"冒充成"不能写"。

放在哪一层
==========

在 ``channel_submit._submit_group`` 的上游通道分支里、**建任务之前**。放在这里而不是路由里，
是因为「这次会不会走上游通道、有没有目标」只有分流层知道：没有目标就没有花费，不必拦。

边界（如实写出来）
==================

预检依赖上游如实回报。上游目前不回可写性，因此 ``configured_unverified`` 是**降级放行**；
要真正堵住 403，需要上游在健康检查里增加「可写性」探测（见报告的「最小上游改动集」）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from fastapi import HTTPException

from app.services.studio.image_pipeline import external_image_client as client

#: 结构化错误码：页面据此给出可执行的修法
STORAGE_BLOCKED_CODE = "storage_not_ready"

STATE_WRITABLE = "writable"
STATE_CONFIGURED_UNVERIFIED = "configured_unverified"
STATE_NOT_CONFIGURED = "not_configured"
STATE_NOT_WRITABLE = "not_writable"
STATE_UNREACHABLE = "unreachable"

_FIX_SUFFIX = "配好之后回到本页重新提交；本次不会产生任何费用。"


@dataclass
class StorageReadiness:
    """一次存储预检的结论（可审计：状态、文案、需要谁去修）。"""

    ok: bool
    state: str
    message: str = ""
    fix_hint: str = ""
    missing: list[str] = field(default_factory=list)
    #: 需要**上游**配合才能彻底解决的点；空串表示不需要
    needs_upstream: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    def as_detail(self) -> dict[str, Any]:
        return {
            "code": STORAGE_BLOCKED_CODE,
            "storage_state": self.state,
            "message": self.message,
            "fix_hint": self.fix_hint,
            "missing": list(self.missing),
            "needs_upstream": self.needs_upstream,
            "oss_health": self.raw,
            # 与既有的可达性预检同一口径：拦下就是「一个请求都没发」
            "paid_call_made": False,
        }


def evaluate_storage_readiness(health: dict[str, Any] | None) -> StorageReadiness:
    """只看健康检查的返回，判定存储能不能接住这次出图。

    纯函数：不联网、不读环境变量，便于把每一条分支都钉在测试里。
    """
    payload = health if isinstance(health, dict) else {}
    oss = payload.get("oss")
    if not isinstance(oss, dict):
        # 上游没报存储信息 → 无法判定。既不假装通过，也不无谓地拦：
        # 如实降级为「配置了但没验过」，并把风险写进文案。
        return StorageReadiness(
            ok=True,
            state=STATE_CONFIGURED_UNVERIFIED,
            message="出图服务没有回报长期存储状态，无法确认这次出图能不能取回。",
            fix_hint=(
                "请让管理员在出图服务的健康检查里补上存储状态；本次先按「已配置」放行，"
                "若图取不回来会在结果里明确标成「部分成功」，图仍可采纳。"
            ),
            needs_upstream="上游健康检查缺少 oss 字段（无法判定可写性）。",
            raw=payload,
        )

    configured = bool(oss.get("configured"))
    missing = [str(x) for x in (oss.get("missing") or []) if str(x).strip()]
    writable = oss.get("writable")
    blocked_reason = str(oss.get("blocked_reason") or "").strip()

    if not configured:
        return StorageReadiness(
            ok=False,
            state=STATE_NOT_CONFIGURED,
            message=(
                "出图服务的长期存储还没配置：现在出图会是「图出来了但取不回来」，"
                "而这次出图是**要计费**的。"
            ),
            fix_hint=(
                (("缺少的配置项：" + "、".join(missing) + "。") if missing else "")
                + "请在出图服务里补齐长期存储（OSS）配置，"
                + _FIX_SUFFIX
            ),
            missing=missing,
            raw=payload,
        )

    if writable is False:
        return StorageReadiness(
            ok=False,
            state=STATE_NOT_WRITABLE,
            message=(
                "长期存储配置齐全，但**写入被拒**"
                + (f"（{blocked_reason}）" if blocked_reason else "")
                + "：照现在提交会是「图出来了、取不回来」，而这次出图是**要计费**的。"
            ),
            fix_hint=(
                "请让管理员给出图服务用的那个账号开通该存储桶的写权限"
                "（常见原因是桶的 ACL/策略只给了读、或 Key 只有只读权限），"
                + _FIX_SUFFIX
            ),
            raw=payload,
        )

    if writable is True:
        return StorageReadiness(ok=True, state=STATE_WRITABLE, raw=payload)

    # 配了、但没回报可写性 —— 当前上游就是这个形态。**不假装验过**。
    return StorageReadiness(
        ok=True,
        state=STATE_CONFIGURED_UNVERIFIED,
        message="长期存储已配置，但出图服务目前只回报「配没配」、不回报「写不写得进去」。",
        fix_hint=(
            "已知的真实失败形态是**写入被拒**（HTTP 403 AccessDenied / bucket acl）："
            "配置齐全也会发生。若这次出图落库失败，结果会明确标成「部分成功」并保留可采纳的图；"
            "要让提交前就能拦下，需要出图服务的健康检查增加可写性探测。"
        ),
        needs_upstream="上游健康检查需要增加长期存储「可写性」探测（探针或最小写删自检）。",
        raw=payload,
    )


class StoragePrecheckBlocked(HTTPException):
    """存储不可用 → 拦下本次出图（**一个请求都没发、没有费用**）。

    刻意继承 ``HTTPException``：路由层既有的 ``except HTTPException`` 分支会把
    ``detail`` 原样放进结构化信封（与付费守卫同一条路），不需要在路由里再加一个分支。
    """

    def __init__(self, readiness: StorageReadiness) -> None:
        self.readiness = readiness
        super().__init__(status_code=409, detail=readiness.as_detail())


async def ensure_vendor_storage_ready(
    *,
    transport: Any = None,
    probe: Any = None,
) -> StorageReadiness:
    """查一次出图服务的健康状态并给出结论（只读、免费）。

    ``probe`` / ``transport`` 供测试注入：默认走 :func:`client.probe_health`。
    """
    from app.services.studio.llm_orchestration import dry_run

    if dry_run.dry_run_enabled():
        # 演练模式本来就不会真出图 → 不需要、也不应该去连上游（守卫会直接拦住）。
        return StorageReadiness(
            ok=True,
            state=STATE_CONFIGURED_UNVERIFIED,
            message="演练模式：跳过存储预检。",
        )

    runner = probe or client.probe_health
    try:
        health = await runner(transport=transport)
    except Exception as exc:  # noqa: BLE001 - 探不动 ≠ 不能写：如实降级，不许冒充结论
        # 为什么不在这里拦：连不上出图服务时，"创建出图任务"这一步本身就会失败，不会真花钱；
        # 而且守卫（未确认 / 出口未授权）也走这条探测路径，抢着报错会把守卫该报的错盖掉。
        return StorageReadiness(
            ok=True,
            state=STATE_UNREACHABLE,
            message=f"没能确认长期存储是否可用（{exc}）：可能是出图服务没起、也可能是本文这一次调用不被允许。",
            fix_hint=(
                "若出图服务没起，先把它跑起来（本机默认 127.0.0.1:4173，见 /api/service/health）；"
                "真正的失败原因会在下面的提交结果里如实给出。"
            ),
        )
    return evaluate_storage_readiness(health)


async def ensure_vendor_storage_ready_or_raise(
    *,
    transport: Any = None,
    probe: Any = None,
) -> StorageReadiness:
    readiness = await ensure_vendor_storage_ready(transport=transport, probe=probe)
    if not readiness.ok:
        raise StoragePrecheckBlocked(readiness)
    return readiness


__all__ = [
    "STATE_CONFIGURED_UNVERIFIED",
    "STATE_NOT_CONFIGURED",
    "STATE_NOT_WRITABLE",
    "STATE_UNREACHABLE",
    "STATE_WRITABLE",
    "STORAGE_BLOCKED_CODE",
    "StoragePrecheckBlocked",
    "StorageReadiness",
    "ensure_vendor_storage_ready",
    "ensure_vendor_storage_ready_or_raise",
    "evaluate_storage_readiness",
]
