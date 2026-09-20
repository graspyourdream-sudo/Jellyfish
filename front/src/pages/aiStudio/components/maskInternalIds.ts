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
/** 后端提示里常直接写字段名（例如「该帧槽位没有 file_id」）——换成业务说法。 */
const FIELD_NAME_RE = /\b(?:file_id|storage_key|video_prompt_source|shot_details)\b/gi
const FIELD_NAME_LABELS: Record<string, string> = {
  file_id: '文件编号',
  storage_key: '存储位置',
  video_prompt_source: '提示词来源',
  shot_details: '镜头记录',
}

export const INTERNAL_ID_PLACEHOLDER = '（内部 ID 见「技术详情」）'

export function maskInternalIds(text: string): string {
  return String(text ?? '')
    .replace(KEY_VALUE_RE, INTERNAL_ID_PLACEHOLDER)
    .replace(BARE_STORAGE_KEY_RE, INTERNAL_ID_PLACEHOLDER)
    .replace(UUID_RE, INTERNAL_ID_PLACEHOLDER)
    .replace(FIELD_NAME_RE, (match) => FIELD_NAME_LABELS[match.toLowerCase()] ?? match)
}

/** 是否含内部标识（用于测试与自检）。 */
export function containsInternalId(text: string): boolean {
  return maskInternalIds(text) !== String(text ?? '')
}
