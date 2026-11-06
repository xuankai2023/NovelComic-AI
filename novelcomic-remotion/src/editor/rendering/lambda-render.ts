import { COMP_NAME, DISK_SIZE_IN_MB, MEM_SIZE_IN_MB, SITE_NAME, TIMEOUT_IN_SECONDS } from '../../remotion/constants'
import { copyRenderOutputToStorage, editorExportFileName, resolveDoneOutputFile } from './output-file'
import { requireServerEnv } from './server-env'
import type { GetProgressPayload, GetProgressResponse, RenderVideoPayload, RenderVideoResponse } from './types'

export type LambdaRenderSubmitter = (payload: RenderVideoPayload) => Promise<RenderVideoResponse>
export type LambdaProgressGetter = (payload: GetProgressPayload) => Promise<GetProgressResponse>

type LambdaRegion = Parameters<
  Awaited<typeof import('@remotion/lambda/client')>['renderMediaOnLambda']
>[0]['region']

export const renderSettings = {
  timeoutInSeconds: TIMEOUT_IN_SECONDS,
  memorySizeInMb: MEM_SIZE_IN_MB,
  diskSizeInMb: DISK_SIZE_IN_MB,
  codec: 'h264' as const,
}

export const submitLambdaRender: LambdaRenderSubmitter = async (payload) => {
  const { renderMediaOnLambda, speculateFunctionName } = await import('@remotion/lambda/client')
  const serverEnv = requireServerEnv()
  const region = serverEnv.REMOTION_AWS_REGION as LambdaRegion
  const { bucketName, renderId } = await renderMediaOnLambda({
    codec: 'h264',
    inputProps: {
      compositionHeight: payload.compositionHeight,
      compositionWidth: payload.compositionWidth,
      assets: payload.assets,
      items: payload.items,
      tracks: payload.tracks,
      fps: payload.fps,
    },
    composition: COMP_NAME,
    functionName: speculateFunctionName({
      diskSizeInMb: DISK_SIZE_IN_MB,
      memorySizeInMb: MEM_SIZE_IN_MB,
      timeoutInSeconds: TIMEOUT_IN_SECONDS,
    }),
    colorSpace: 'bt709',
    region,
    serveUrl: SITE_NAME,
    downloadBehavior: {
      fileName: 'novelcomic-render.mp4',
      type: 'download',
    },
    timeoutInMilliseconds: 120000,
  })
  return { type: 'success', renderId, bucketName }
}

export const getLambdaProgress: LambdaProgressGetter = async (payload) => {
  if (!payload.renderId || !payload.bucketName) {
    return { type: 'error', error: 'renderId and bucketName are required' }
  }
  const { getRenderProgress, speculateFunctionName } = await import('@remotion/lambda/client')
  const serverEnv = requireServerEnv()
  const region = serverEnv.REMOTION_AWS_REGION as LambdaRegion
  const progress = await getRenderProgress({
    bucketName: payload.bucketName,
    renderId: payload.renderId,
    functionName: speculateFunctionName({
      diskSizeInMb: DISK_SIZE_IN_MB,
      memorySizeInMb: MEM_SIZE_IN_MB,
      timeoutInSeconds: TIMEOUT_IN_SECONDS,
    }),
    region,
    skipLambdaInvocation: false,
  })
  if (progress.done) {
    const outputName = editorExportFileName()
    const outputFile = await resolveDoneOutputFile({
      sourceUrl: progress.outputFile as string,
      renderId: payload.renderId,
      outputName,
      copy: copyRenderOutputToStorage,
    })
    return {
      type: 'done',
      outputFile,
      outputSizeInBytes: progress.outputSizeInBytes ?? 0,
    }
  }
  if (progress.fatalErrorEncountered) {
    return {
      type: 'error',
      error: progress.errors?.[0]?.message || 'Render failed',
    }
  }
  return {
    type: 'in-progress',
    overallProgress: progress.overallProgress,
  }
}
