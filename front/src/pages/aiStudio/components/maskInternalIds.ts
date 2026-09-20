/**
 * 主界面上的内部标识屏蔽（第三部分要求四）。
 *
 * 普通界面只显示用户要决定的内容（画幅 / 时长 / 参考方式 / 模型方案的业务名称 / 缺失项 / 生成状态）；
 * 供应商名、内部 ID、`file_id`、`storage_key`、接口参数统一收进默认折叠的「技术详情」。
 *
 * 后端的一些提示语（例如「对象存储读取失败（key=…）」）会内嵌这些标识，
 * 这里把它们换成一句指路，原文仍在「技术详情」里可查。
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const KEY_VALUE_RE = /\b(?:file_id|storage_key|asset_id|shot_id|chapter_id)=\S+/gi
const BARE_STORAGE_KEY_RE = /\bkey=[^\s）)]+/gi

export const INTERNAL_ID_PLACEHOLDER = '（内部 ID 见「技术详情」）'

export function maskInternalIds(text: string): string {
  return String(text ?? '')
    .replace(UUID_RE, INTERNAL_ID_PLACEHOLDER)
    .replace(KEY_VALUE_RE, INTERNAL_ID_PLACEHOLDER)
    .replace(BARE_STORAGE_KEY_RE, INTERNAL_ID_PLACEHOLDER)
}

/** 是否含内部标识（用于测试与自检）。 */
export function containsInternalId(text: string): boolean {
  return maskInternalIds(text) !== String(text ?? '')
}
