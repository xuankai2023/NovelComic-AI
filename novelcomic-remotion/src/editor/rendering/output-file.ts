export function editorExportFileName(now = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('')
  return `cut_video_${stamp}.mp4`
}

export function renderOutputObjectKey(renderId: string, outputName: string) {
  return `renders/${renderId}/${outputName}`
}

export async function resolveDoneOutputFile(params: {
  sourceUrl: string
  renderId: string
  outputName: string
  copy: (sourceUrl: string, destKey: string) => Promise<string>
}) {
  try {
    return await params.copy(params.sourceUrl, renderOutputObjectKey(params.renderId, params.outputName))
  } catch {
    return params.sourceUrl
  }
}

export async function copyRenderOutputToStorage(sourceUrl: string, destKey: string) {
  const cdnBase = process.env.COS_CDN_BASE_URL?.replace(/\/+$/, '')
  if (!process.env.COS_BUCKET || !cdnBase) {
    throw new Error('COS is not configured')
  }
  const response = await fetch(sourceUrl)
  if (!response.ok) throw new Error(`Failed to fetch render output: ${response.status}`)
  return `${cdnBase}/${destKey}`
}
