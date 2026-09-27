import { StudioImageTasksService } from '../../../services/generated'
import { StudioEntitiesApi } from '../../../services/studioEntities'
import type { AssetEditPageBaseProps, BaseAsset, BaseAssetImage } from './components/AssetEditPageBase'

type AdapterConfig<TAsset extends BaseAsset, TImage extends BaseAssetImage> = Omit<
  AssetEditPageBaseProps<TAsset, TImage>,
  'assetId' | 'onNavigate'
>

type UpdateImagePayload = {
  file_id: string
  width?: number | null
  height?: number | null
  format?: string | null
}

function normalizeUpdateImagePayload(payload: UpdateImagePayload): UpdateImagePayload {
  return {
    ...payload,
    format: payload.format ?? 'png',
  }
}

/**
 * 地址里没有资产编号时给用户看的话（审计 §4.6 模式 2）。
 *
 * 原来五处分别写 `缺少 character_id` / `缺少 actor_id` / `缺少 scene_id` /
 * `缺少 prop_id` / `缺少 costume_id` —— **后端字段名直接上屏**，而且五处口径不一致。
 * 用户要的是「怎么办」，不是字段名叫什么。
 */
const MISSING_ASSET_ID_TEXT = '地址里没有资产编号，请从项目工作台第 2 步「资产准备」进入'

export const assetAdapters = {
  character: {
    missingAssetIdText: MISSING_ASSET_ID_TEXT,
    assetDisplayName: '角色',
    backTo: '/projects',
    relationType: 'character_image',
    getAsset: async (id: string) => {
      const res = await StudioEntitiesApi.get('character', id)
      return (res.data ?? null) as any | null
    },
    updateAsset: async (id: string, payload) => {
      const res = await StudioEntitiesApi.update('character', id, payload as Record<string, unknown>)
      return (res.data ?? null) as any | null
    },
    listImages: async (id: string) => {
      const res = await StudioEntitiesApi.listImages('character', id, { page: 1, pageSize: 100 })
      return (res.data?.items ?? []) as any[]
    },
    createImageSlot: async (id: string, angle) => {
      await StudioEntitiesApi.createImage('character', id, { view_angle: angle })
    },
    updateImage: async (id: string, imageId: number, payload) => {
      await StudioEntitiesApi.updateImage('character', id, imageId, normalizeUpdateImagePayload(payload))
    },
    renderPrompt: async (id: string, imageId: number) => {
      const res = await StudioImageTasksService.renderCharacterImagePromptApiV1StudioImageTasksCharactersCharacterIdRenderPromptPost({
        characterId: id,
        requestBody: { image_id: imageId, model_id: null } as any,
      })
      const data = res.data
      return {
        prompt: (data?.prompt ?? '') as string,
        images: (data?.images ?? []) as string[],
      }
    },
  } satisfies AdapterConfig<any, any>,
  actor: {
    missingAssetIdText: MISSING_ASSET_ID_TEXT,
    assetDisplayName: '演员',
    backTo: '/assets?tab=actor',
    relationType: 'actor_image',
    getAsset: async (id: string) => {
      const res = await StudioEntitiesApi.get('actor', id)
      return (res.data ?? null) as any | null
    },
    updateAsset: async (id: string, payload) => {
      const res = await StudioEntitiesApi.update('actor', id, payload as Record<string, unknown>)
      return (res.data ?? null) as any | null
    },
    listImages: async (id: string) => {
      const res = await StudioEntitiesApi.listImages('actor', id, { page: 1, pageSize: 100 })
      return (res.data?.items ?? []) as any[]
    },
    createImageSlot: async (id: string, angle) => {
      await StudioEntitiesApi.createImage('actor', id, { view_angle: angle })
    },
    updateImage: async (id: string, imageId: number, payload) => {
      await StudioEntitiesApi.updateImage('actor', id, imageId, normalizeUpdateImagePayload(payload))
    },
    renderPrompt: async (id: string, imageId: number) => {
      const res = await StudioImageTasksService.renderActorImagePromptApiV1StudioImageTasksActorsActorIdRenderPromptPost({
        actorId: id,
        requestBody: { image_id: imageId, model_id: null } as any,
      })
      const data = res.data
      return {
        prompt: (data?.prompt ?? '') as string,
        images: (data?.images ?? []) as string[],
      }
    },
  } satisfies AdapterConfig<any, any>,
  scene: {
    missingAssetIdText: MISSING_ASSET_ID_TEXT,
    assetDisplayName: '场景',
    backTo: '/assets?tab=scene',
    relationType: 'scene_image',
    getAsset: async (id: string) => {
      const res = await StudioEntitiesApi.get('scene', id)
      return (res.data ?? null) as any | null
    },
    updateAsset: async (id: string, payload) => {
      const res = await StudioEntitiesApi.update('scene', id, payload as Record<string, unknown>)
      return (res.data ?? null) as any | null
    },
    listImages: async (id: string) => {
      const res = await StudioEntitiesApi.listImages('scene', id, { page: 1, pageSize: 100 })
      return (res.data?.items ?? []) as any[]
    },
    createImageSlot: async (id: string, angle) => {
      await StudioEntitiesApi.createImage('scene', id, { view_angle: angle })
    },
    updateImage: async (id: string, imageId: number, payload) => {
      await StudioEntitiesApi.updateImage('scene', id, imageId, normalizeUpdateImagePayload(payload))
    },
    renderPrompt: async (id: string, imageId: number) => {
      const res = await StudioImageTasksService.renderAssetImagePromptApiV1StudioImageTasksAssetsAssetTypeAssetIdRenderPromptPost({
        assetType: 'scene',
        assetId: id,
        requestBody: { image_id: imageId, model_id: null } as any,
      })
      const data = res.data
      return {
        prompt: (data?.prompt ?? '') as string,
        images: (data?.images ?? []) as string[],
      }
    },
  } satisfies AdapterConfig<any, any>,
  prop: {
    missingAssetIdText: MISSING_ASSET_ID_TEXT,
    assetDisplayName: '道具',
    backTo: '/assets?tab=prop',
    relationType: 'prop_image',
    getAsset: async (id: string) => {
      const res = await StudioEntitiesApi.get('prop', id)
      return (res.data ?? null) as any | null
    },
    updateAsset: async (id: string, payload) => {
      const res = await StudioEntitiesApi.update('prop', id, payload as Record<string, unknown>)
      return (res.data ?? null) as any | null
    },
    listImages: async (id: string) => {
      const res = await StudioEntitiesApi.listImages('prop', id, { page: 1, pageSize: 100 })
      return (res.data?.items ?? []) as any[]
    },
    createImageSlot: async (id: string, angle) => {
      await StudioEntitiesApi.createImage('prop', id, { view_angle: angle })
    },
    updateImage: async (id: string, imageId: number, payload) => {
      await StudioEntitiesApi.updateImage('prop', id, imageId, normalizeUpdateImagePayload(payload))
    },
    renderPrompt: async (id: string, imageId: number) => {
      const res = await StudioImageTasksService.renderAssetImagePromptApiV1StudioImageTasksAssetsAssetTypeAssetIdRenderPromptPost({
        assetType: 'prop',
        assetId: id,
        requestBody: { image_id: imageId, model_id: null } as any,
      })
      const data = res.data
      return {
        prompt: (data?.prompt ?? '') as string,
        images: (data?.images ?? []) as string[],
      }
    },
  } satisfies AdapterConfig<any, any>,
  costume: {
    missingAssetIdText: MISSING_ASSET_ID_TEXT,
    assetDisplayName: '服装',
    backTo: '/assets?tab=costume',
    relationType: 'costume_image',
    getAsset: async (id: string) => {
      const res = await StudioEntitiesApi.get('costume', id)
      return (res.data ?? null) as any | null
    },
    updateAsset: async (id: string, payload) => {
      const res = await StudioEntitiesApi.update('costume', id, payload as Record<string, unknown>)
      return (res.data ?? null) as any | null
    },
    listImages: async (id: string) => {
      const res = await StudioEntitiesApi.listImages('costume', id, { page: 1, pageSize: 100 })
      return (res.data?.items ?? []) as any[]
    },
    createImageSlot: async (id: string, angle) => {
      await StudioEntitiesApi.createImage('costume', id, { view_angle: angle })
    },
    updateImage: async (id: string, imageId: number, payload) => {
      await StudioEntitiesApi.updateImage('costume', id, imageId, normalizeUpdateImagePayload(payload))
    },
    renderPrompt: async (id: string, imageId: number) => {
      const res = await StudioImageTasksService.renderAssetImagePromptApiV1StudioImageTasksAssetsAssetTypeAssetIdRenderPromptPost({
        assetType: 'costume',
        assetId: id,
        requestBody: { image_id: imageId, model_id: null } as any,
      })
      const data = res.data
      return {
        prompt: (data?.prompt ?? '') as string,
        images: (data?.images ?? []) as string[],
      }
    },
  } satisfies AdapterConfig<any, any>,

  /**
   * 商品（第五类资产）。
   *
   * 与其余几类共用实体 CRUD（`product` 分支）；**唯一**的差别是：
   * 商品图不走出图通道（契约 §六），所以：
   *   - 编辑页的「出图 / 重新生成」按钮对本页是禁用的（`AssetEditPageBase` 按实体类型判定）；
   *   - `renderPrompt` 在这里是**明确的拒绝**（带中文原因），而不是悄悄拿别的资产类型去请求。
   * 这一页真正要用的是「上传图片（写槽位）」+「设为定版」两个既有动作。
   */
  product: {
    missingAssetIdText: MISSING_ASSET_ID_TEXT,
    assetDisplayName: '商品',
    backTo: '/assets?tab=product',
    relationType: 'product_image',
    getAsset: async (id: string) => {
      const res = await StudioEntitiesApi.get('product', id)
      return (res.data ?? null) as any | null
    },
    updateAsset: async (id: string, payload) => {
      const res = await StudioEntitiesApi.update('product', id, payload as Record<string, unknown>)
      return (res.data ?? null) as any | null
    },
    listImages: async (id: string) => {
      const res = await StudioEntitiesApi.listImages('product', id, { page: 1, pageSize: 100 })
      return (res.data?.items ?? []) as any[]
    },
    createImageSlot: async (id: string, angle) => {
      await StudioEntitiesApi.createImage('product', id, { view_angle: angle })
    },
    updateImage: async (id: string, imageId: number, payload) => {
      await StudioEntitiesApi.updateImage('product', id, imageId, normalizeUpdateImagePayload(payload))
    },
    renderPrompt: async () => {
      /* 这一条路径在页面上是禁用的（商品不走出图通道）；真被调用到也不静默：
         给出中文原因，让排查的人一眼看出是"能力边界"而不是"接口挂了"。 */
      throw new Error('商品图不走出图通道：请在商品资产页上传图片并手动「设为定版」')
    },
  } satisfies AdapterConfig<any, any>,
}
