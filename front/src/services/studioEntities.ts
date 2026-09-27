import { StudioEntitiesService } from './generated'
import { OpenAPI } from './generated/core/OpenAPI'
/* 与 `dramaPlanApi` 同一口径：错误只用**唯一**的构造出口（`buildRequestFailure`），
   自己拼一套 `GenerationRequestError` 会让同一条管道出现两种话术。 */
import { buildRequestFailure } from './llmPipelineApi'

/**
 * 实体类型（所有实体 CRUD 的收口）。
 *
 * `product` 是第五类资产（契约 §六）：它和其余几类共用**同一套**实体端点
 * （`/studio/entities/product/...`，含 `images` 列表 / 新建槽位 /
 * `PATCH .../images/{image_id}` 定版），所以商品图的「上传 + 手动定版」
 * 不需要新接口，只需要把类型放进来。
 */
type EntityType = 'actor' | 'character' | 'scene' | 'prop' | 'costume' | 'product'

export const StudioEntitiesApi = {
  list(entityType: EntityType, params: { q?: string | null; page?: number; pageSize?: number; order?: string | null; isDesc?: boolean }) {
    return StudioEntitiesService.listEntitiesApiV1StudioEntitiesEntityTypeGet({
      entityType,
      q: params.q ?? null,
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 10,
      order: params.order ?? null,
      isDesc: params.isDesc ?? false,
    })
  },
  get(entityType: EntityType, entityId: string) {
    return StudioEntitiesService.getEntityApiV1StudioEntitiesEntityTypeEntityIdGet({
      entityType,
      entityId,
    })
  },
  create(entityType: EntityType, payload: Record<string, unknown>) {
    return StudioEntitiesService.createEntityApiV1StudioEntitiesEntityTypePost({
      entityType,
      requestBody: payload,
    })
  },
  update(entityType: EntityType, entityId: string, payload: Record<string, unknown>) {
    return StudioEntitiesService.updateEntityApiV1StudioEntitiesEntityTypeEntityIdPatch({
      entityType,
      entityId,
      requestBody: payload,
    })
  },
  remove(entityType: EntityType, entityId: string) {
    return StudioEntitiesService.deleteEntityApiV1StudioEntitiesEntityTypeEntityIdDelete({
      entityType,
      entityId,
    })
  },
  listImages(entityType: EntityType, entityId: string, params: { page?: number; pageSize?: number; order?: string | null; isDesc?: boolean }) {
    return StudioEntitiesService.listEntityImagesApiV1StudioEntitiesEntityTypeEntityIdImagesGet({
      entityType,
      entityId,
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 10,
      order: params.order ?? null,
      isDesc: params.isDesc ?? false,
    })
  },
  createImage(entityType: EntityType, entityId: string, payload: Record<string, unknown>) {
    return StudioEntitiesService.createEntityImageApiV1StudioEntitiesEntityTypeEntityIdImagesPost({
      entityType,
      entityId,
      requestBody: payload,
    })
  },
  updateImage(entityType: EntityType, entityId: string, imageId: number, payload: Record<string, unknown>) {
    return StudioEntitiesService.updateEntityImageApiV1StudioEntitiesEntityTypeEntityIdImagesImageIdPatch({
      entityType,
      entityId,
      imageId,
      requestBody: payload,
    })
  },
  deleteImage(entityType: EntityType, entityId: string, imageId: number) {
    return StudioEntitiesService.deleteEntityImageApiV1StudioEntitiesEntityTypeEntityIdImagesImageIdDelete({
      entityType,
      entityId,
      imageId,
    })
  },
}


/* ---------------------------------------------------------------------------
 * 分镜 ↔ 商品 关联
 *
 * 为什么这几条是手写而不是走生成客户端：`front/openapi.json` 已经漂移，
 * 生成客户端里没有 `POST/DELETE /studio/shot-links/product`（只有
 * scene / prop / costume 三条）。本批约定**不统一重新生成**，所以在这里补薄封装，
 * 形状与生成客户端里那三条 `createProject*Link` **完全一致**（同一套请求体字段）。
 *
 * 商品是全局资产（`products` 表不带 project_id），项目 / 章节 / 镜头通过
 * `project_product_links` 关联它；列表查询用生成客户端里那条通用列表即可
 * （`StudioShotLinksService.listProjectEntityLinksApiV1StudioShotLinksEntityTypeGet`，
 * 它的 `entityType` 形参本来就是 `string`）。
 * ------------------------------------------------------------------------- */

/** 分镜↔商品关联行（只列调用方真正用得到的列）。 */
export type ShotProductLink = {
  id: number
  project_id?: string
  chapter_id?: string | null
  shot_id?: string | null
  product_id?: string
}

export type ShotProductLinkCreateBody = {
  project_id: string
  chapter_id: string
  shot_id: string
  /** 商品资产 ID（后端字段名就是 `asset_id`，与另外三类 link 端点一致） */
  asset_id: string
}

async function requestStudioJson<T>(
  path: string,
  init: RequestInit,
): Promise<T | null> {
  const response = await fetch(`${OpenAPI.BASE}${path}`, init)
  const text = await response.text()
  let payload: Record<string, unknown> | undefined
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : undefined
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    throw buildRequestFailure(null, response.status, text, payload)
  }
  return (payload?.data ?? null) as T | null
}

/** 把商品关联到某个镜头（与 scene / prop / costume 三条端点同形状）。 */
export function createShotProductLink(body: ShotProductLinkCreateBody): Promise<ShotProductLink | null> {
  return requestStudioJson<ShotProductLink>('/api/v1/studio/shot-links/product', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 解除一条商品关联（按关联行 ID 删；解绑的是**这一条关联**，不动商品本身）。 */
export function deleteShotProductLink(linkId: number | string): Promise<null> {
  return requestStudioJson<null>(`/api/v1/studio/shot-links/product/${encodeURIComponent(String(linkId))}`, {
    method: 'DELETE',
  })
}
