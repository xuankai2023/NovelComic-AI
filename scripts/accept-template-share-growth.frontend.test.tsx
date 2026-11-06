import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { fetchPublicModelConfigs } from '../novelcomic-frontend/src/api/modules/models'
import { fetchAgentCatalogHooks, fetchAgentCatalogRoles } from '../novelcomic-frontend/src/api/modules/agent-catalog'
import { fetchTemplateCategories, fetchTemplatesPage } from '../novelcomic-frontend/src/api/modules/templates'
import {
  clearTemplateQueryCaches,
  getHomeCategoryTemplatesCached,
  getTemplateCategoriesCached,
} from '../novelcomic-frontend/src/api/queries/templates'
import {
  getCloudModelOptions,
  LOCAL_CLOUD_MODEL_DATA,
} from '../novelcomic-frontend/src/constants/cloudModelData'
import { applyModelDropdownOrder } from '../novelcomic-frontend/src/constants/modelDropdownOrder'
import { buildTemplateViewPath } from '../novelcomic-frontend/src/lib/template-links'
import { captureInviteCodeFromUrl, clearStoredInviteCode, getStoredInviteCode } from '../novelcomic-frontend/src/lib/invite-code'
import {
  buildClonedTemplateGraph,
  buildTemplateSaveData,
  savePendingTemplateCopy,
} from '../novelcomic-frontend/src/features/canvas-workflow/hooks/flow/use-copy-template'
import { shareSnapshotToWorkflowProject } from '../novelcomic-frontend/src/features/canvas-workflow/hooks/flow/use-flow-share'
import WorkflowPreviewPanel from '../novelcomic-frontend/src/components/home/template/items/workflow_preview_panel'
import {
  buildShareEarnInviteLink,
  copyShareEarnInviteLink,
  openShareEarnExternal,
} from '../novelcomic-frontend/src/components/home/navbar/items/share-earn-modal'

const calls = vi.hoisted(() => [] as Array<{ url: string; headers?: Record<string, string> }>)

vi.mock('../novelcomic-frontend/src/api/client', () => ({
  request: async (url: string, options: { headers?: Record<string, string> } = {}) => {
    calls.push({ url: String(url), headers: options.headers })
    if (String(url).includes('/templates/categories/list')) {
      return {
        status: 200,
        data: [
          {
            id: 'story',
            path: 'story/',
            label: { zh: '故事', en: 'Story' },
            level: 1,
            parent_id: null,
            sort_order: 1,
            template_count: 2,
          },
        ],
      }
    }
    if (String(url).includes('/templates/page')) {
      return {
        status: 200,
        data: {
          items: [
            {
              template_id: 'published-1',
              name: { zh: '已发布模板' },
              desc: {},
              origin_flow_id: 'flow-1',
              share_id: 'share-1',
            },
          ],
        },
      }
    }
    if (String(url).includes('/models/list')) {
      return { status: 200, data: [] }
    }
    if (String(url).includes('/models/dropdown-order')) {
      return {
        status: 200,
        data: {
          groups: {
            text_to_video: {
              group: 'text_to_video',
              models: [
                { model_id: 'second', display_name: 'Second' },
                { model_id: 'first', display_name: 'First' },
              ],
            },
          },
        },
      }
    }
    if (String(url).includes('/agent-catalog/')) {
      return { status: 200, data: { items: [], total: 0, page: 1, pageSize: 20 } }
    }
    return { status: 200, data: null }
  },
  ApiError: class ApiError extends Error {},
  AuthNotReadyError: class AuthNotReadyError extends Error {},
  getApiToken: async () => 'unused-token',
  setTokenProvider: () => {},
}))

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'novelcomic-frontend', 'src')

interface CheckResult {
  step: number
  name: string
  ok: boolean
  detail: string
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      files.push(...walk(path))
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

function sourceFiles() {
  return walk(srcRoot).filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
}

function read(path: string) {
  return readFileSync(path, 'utf8')
}

async function check(results: CheckResult[], step: number, name: string, fn: () => Promise<string> | string) {
  try {
    const detail = await fn()
    results.push({ step, name, ok: true, detail: detail || 'ok' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ step, name, ok: false, detail: message })
  }
}

it('验收模板市场、复制、目录、分享落地、邀请和 B2B 的前端链路', async () => {
  const results: CheckResult[] = []
  const storage = new Map<string, string>()
  const session = new Map<string, string>()
  const opened: string[] = []
  let copied = ''
  const sessionStorage = {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => {
      session.set(key, value)
    },
    removeItem: (key: string) => {
      session.delete(key)
    },
  }
  vi.stubGlobal('sessionStorage', sessionStorage)
  vi.stubGlobal('window', {
    location: { origin: 'https://novelcomic.test', href: 'https://novelcomic.test/?invite=ncabc' },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    sessionStorage,
    open: (url: string) => {
      opened.push(url)
      return null
    },
    dispatchEvent: () => true,
  })
  vi.stubGlobal('navigator', {
    clipboard: {
      writeText: async (value: string) => {
        copied = value
      },
    },
    language: 'zh-CN',
  })
  vi.stubGlobal('CustomEvent', class CustomEvent {
    type: string
    detail: unknown
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type
      this.detail = init?.detail
    }
  })

  await check(results, 1, '技能页公开请求模板，不带登录 token', async () => {
    calls.length = 0
    const { default: AgentSkillsPage } = await import('../novelcomic-frontend/src/features/agent-skills/components/AgentSkillsPage')
    const html = renderToStaticMarkup(<AgentSkillsPage tab="workflow" />)
    const page = await fetchTemplatesPage(1, 20)
    const categories = await fetchTemplateCategories()
    const templateCalls = calls.filter((call) => call.url.includes('/api/v1/templates/'))
    const skillsSource = read(join(srcRoot, 'routes/skills.tsx'))
    expect(skillsSource).toContain("path: '/skills'")
    expect(skillsSource).toContain('AgentSkillsPage')
    expect(html).toContain('模板市场')
    expect(templateCalls.length).toBeGreaterThan(0)
    expect(templateCalls.every((call) => !call.headers?.Authorization)).toBe(true)
    expect(page.items.map((item) => item.template_id)).toContain('published-1')
    expect(categories[0]?.template_count).toBe(2)
    return `calls=${templateCalls.map((call) => call.url).join(',')}`
  })

  await check(results, 2, '首页分类轨和导航预取同一套分类缓存', async () => {
    clearTemplateQueryCaches()
    calls.length = 0
    const first = await getTemplateCategoriesCached()
    const second = await getTemplateCategoriesCached()
    const home = await getHomeCategoryTemplatesCached('story/')
    const categoryCalls = calls.filter((call) => call.url.includes('/templates/categories/list'))
    expect(first).toBe(second)
    expect(categoryCalls).toHaveLength(1)
    expect(home.items).toHaveLength(1)
    const categoryRow = read(join(srcRoot, 'components/home/home-page/items/category-template-row.tsx'))
    const templateList = read(join(srcRoot, 'components/home/template/items/template_list.tsx'))
    expect(categoryRow).toContain('useTemplateCategories')
    expect(categoryRow).toContain('useHomeCategoryTemplates')
    expect(templateList).toContain('useTemplateCategories')
    const navbar = sourceFiles().filter((file) => file.includes(`${join('components', 'home', 'navbar')}${join('', '')}`) || file.endsWith(`${join('components', 'home', 'navbar')}.tsx`) || file.endsWith('/navbar.tsx') || file.endsWith('\\navbar.tsx'))
    const navbarPrefetch = sourceFiles().filter((file) => {
      if (file.includes(`${join('api', 'queries', 'templates')}`)) return false
      if (file.includes('category-template-row')) return false
      if (file.includes(`${join('components', 'home', 'template')}`)) return false
      if (file.endsWith('use-templates-query.ts')) return false
      const text = read(file)
      return text.includes('getTemplateCategoriesCached') || text.includes('useTemplateCategories')
    })
    expect(navbar.length > 0 || navbarPrefetch.length > 0, `导航没有预取分类。分类轨文件之外的引用: ${navbarPrefetch.join(', ') || '无'}`).toBe(true)
    const prefetchHitsCategories = navbarPrefetch.some((file) => read(file).includes('useTemplateCategories') || read(file).includes('getTemplateCategoriesCached'))
    expect(prefetchHitsCategories).toBe(true)
    return `cacheHit=1 homeItems=${home.items.length} prefetch=${navbarPrefetch.length}`
  })

  await check(results, 3, '模板卡片进入分享只读页', () => {
    const path = buildTemplateViewPath({
      template_id: 'published-1',
      name: { zh: '已发布模板' },
      desc: {},
      origin_flow_id: 'flow-1',
      share_id: 'share-1',
    })
    expect(path).toBe('/canvas/view/flow-1?shareid=share-1&source=template')
    const card = read(join(srcRoot, 'components/home/template/items/lazy_template_card.tsx'))
    const list = read(join(srcRoot, 'components/home/template/items/template_list.tsx'))
    expect(card).toContain('buildTemplateViewPath')
    expect(list).toContain('LazyTemplateCard')
    return path
  })

  await check(results, 4, '预览只渲染分享快照，Use 清掉运行状态', () => {
    const share = {
      share_id: 'share-1',
      flow_id: 'flow-source',
      owner_user_id: 'author',
      share_type: 'workflow' as const,
      allow_reshare: true,
      snapshot: {
        flow_id: 'flow-source',
        project_name: 'Template Source',
        allow_reshare: true,
        nodes: [
          {
            id: 'node-snapshot',
            type: 'textInput',
            position: { x: 1, y: 2 },
            data: {
              label: 'Snapshot node',
              status: 'completed',
              generated_data: { text: 'runtime output' },
            },
          },
        ],
        edges: [{ id: 'edge-snapshot', source: 'node-snapshot', target: 'node-snapshot' }],
      },
    }
    const workflow = shareSnapshotToWorkflowProject(share)
    expect(workflow?.nodes[0]?.id).toBe('node-snapshot')
    const html = renderToStaticMarkup(<WorkflowPreviewPanel workflow={workflow!} />)
    expect(html).toContain('Snapshot node')
    expect(html).not.toContain('runtime output')
    expect(html).not.toContain('completed')
    expect(html).not.toContain('live-project-node')
    const saveData = buildTemplateSaveData(share)
    expect(saveData?.parent_flow_id).toBe('flow-source')
    expect(saveData?.nodes[0]?.data).toEqual({ label: 'Snapshot node' })
    savePendingTemplateCopy({ shareId: 'share-1', source: 'template_preview' })
    expect([...session.keys()]).toContain('novelcomic:use-template-preview')
    const modal = read(join(srcRoot, 'components/home/template/items/template_preview_modal.tsx'))
    expect(modal).toContain('fetchShareInfo')
    expect(modal).toContain('copyTemplateFromShare')
    expect(modal).not.toContain('getWorkflowProject')
    return 'snapshot rendered, run state stripped'
  })

  await check(results, 5, '只读顶栏和 banner 都能另存', () => {
    const view = read(join(srcRoot, 'routes/canvas.view.$flowId.tsx'))
    expect(view).toContain("source: 'readonly_banner'")
    expect(view).toContain('copyTemplateFromShare')
    const headbar = sourceFiles().filter((file) => {
      const text = read(file)
      return text.includes('copyTemplateFromShare') && /headbar|headBar|HeadBar/.test(text)
    })
    expect(headbar.length, '只读顶栏没有调用另存').toBeGreaterThan(0)
    return headbar.join(',')
  })

  await check(results, 6, '三个编辑入口把快照节点追加进当前图', () => {
    const graph = buildClonedTemplateGraph(
      [{ id: 'current', type: 'imageInput', position: { x: 0, y: 0 }, data: { label: 'current' }, selected: true }],
      [],
      [{ id: 'template-node', type: 'textInput', position: { x: 4, y: 6 }, data: { label: 'added', status: 'done', generated_data: { text: 'x' } } }],
      [{ id: 'template-edge', source: 'template-node', target: 'template-node' }],
      { offset: { x: 10, y: 20 }, createId: (oldId) => `${oldId}-copy` },
    )
    expect(graph.nodes.map((node) => node.id)).toEqual(['current', 'template-node-copy'])
    expect(graph.nodes[1]?.data).toEqual({ label: 'added' })
    expect(graph.edges[0]?.source).toBe('template-node-copy')
    const required = [
      'components/canvas-editor-content/template_modal.tsx',
      'components/canvas-editor-content/template_tools.tsx',
      'features/canvas-workflow/components/panels/creator-shell/creator-skills-panel.tsx',
    ]
    const missing = required.filter((relative) => {
      const path = join(srcRoot, relative)
      return !existsSync(path) || !read(path).includes('cloneTemplateToFlow')
    })
    expect(missing, `这些入口没有把快照追加进当前图: ${missing.join(', ')}`).toEqual([])
    return `appended=${graph.nodes[1]?.id}`
  })

  await check(results, 7, '节点下拉按公开顺序排列，失败时退回本地数据', async () => {
    calls.length = 0
    await fetchPublicModelConfigs('all')
    const modelCall = calls.find((call) => call.url.includes('/api/v1/models/list?config_name=all'))
    expect(modelCall).toBeTruthy()
    expect(modelCall?.headers?.Authorization).toBeUndefined()
    const ordered = applyModelDropdownOrder(
      [
        { id: 'first', label: 'First', priceLabel: '8 credits' },
        { id: 'second', label: 'Second', priceLabel: '3 credits' },
        { id: 'local-only', label: 'Local only' },
      ],
      {
        groups: {
          text_to_video: {
            group: 'text_to_video',
            models: [
              { model_id: 'second', display_name: 'Second' },
              { model_id: 'first', display_name: 'First' },
            ],
          },
        },
      },
      'text_to_video',
    )
    expect(ordered.map((item) => item.id)).toEqual(['second', 'first', 'local-only'])
    expect(getCloudModelOptions([])).toEqual(LOCAL_CLOUD_MODEL_DATA)
    const { useEnrichedModelsData } = await import('../novelcomic-frontend/src/hooks/useCloudModelDataQuery')
    const { ModelSeletion } = await import('../novelcomic-frontend/src/features/canvas-workflow/components/custom_nodes/components/ModelSeletion')
    expect(useEnrichedModelsData.toString()).toContain('LOCAL_CLOUD_MODEL_DATA')
    expect(ModelSeletion.toString()).toContain('useEnrichedModelsData')
    const providers = read(join(srcRoot, 'components/ClientProviders.tsx'))
    const viewProviders = read(join(srcRoot, 'components/providers/view-providers.tsx'))
    expect(providers).toContain('CloudModelDataSync')
    expect(viewProviders).toContain('CloudModelDataSync')
    return ordered.map((item) => item.id).join(',')
  })

  await check(results, 10, '有白名单时只读页停在登录', async () => {
    const { shouldHoldReadonlyShareForLogin } = await import('../novelcomic-frontend/src/routes/canvas.view.$flowId')
    const view = read(join(srcRoot, 'routes/canvas.view.$flowId.tsx'))
    expect(shouldHoldReadonlyShareForLogin({ need_auth: true, snapshot: null })).toBe(true)
    expect(shouldHoldReadonlyShareForLogin({ need_auth: false, snapshot: { nodes: [] } })).toBe(false)
    expect(shouldHoldReadonlyShareForLogin({ need_auth: true, snapshot: { nodes: [{ id: 'n' }] } })).toBe(false)
    expect(view).toContain('shouldHoldReadonlyShareForLogin(share)')
    expect(view).toContain('Log in to view')
    return 'login hold'
  })

  await check(results, 11, 'shareid 落地把 owner 送去编辑页，其他人去只读页', async () => {
    const { resolveShareLandingDestination } = await import('../novelcomic-frontend/src/components/share/share')
    const index = read(join(srcRoot, 'routes/canvas.index.tsx'))
    expect(index).toContain('ShareLanding')
    const owner = resolveShareLandingDestination({
      flowId: 'flow-1',
      shareId: 'share-1',
      ownerUserId: 'user-owner',
      isSignedIn: true,
      userId: 'user-owner',
    })
    const other = resolveShareLandingDestination({
      flowId: 'flow-1',
      shareId: 'share-1',
      ownerUserId: 'user-owner',
      isSignedIn: true,
      userId: 'user-other',
    })
    const guest = resolveShareLandingDestination({
      flowId: 'flow-1',
      shareId: 'share-1',
      ownerUserId: 'user-owner',
      isSignedIn: false,
      userId: null,
    })
    expect(owner.to).toBe('/canvas/$flowId')
    expect(other).toMatchObject({ to: '/canvas/view/$flowId', search: { shareid: 'share-1' } })
    expect(guest.to).toBe('/canvas/view/$flowId')
    return `${owner.to} / ${other.to}`
  })

  await check(results, 12, 'app_and_workflow 会补读 app flow', () => {
    const callers = sourceFiles().filter((file) => {
      if (file.endsWith(`${join('api', 'modules', 'flow.ts')}`)) return false
      return read(file).includes('getAppFlow(')
    })
    const shareView = callers.filter((file) => /canvas|use-one-flow|share/i.test(file))
    expect(shareView.length, `分享页没有补读 app flow。调用点: ${callers.join(', ') || '无'}`).toBeGreaterThan(0)
    const joined = shareView.map(read).join('\n')
    expect(joined).toContain('app_and_workflow')
    return shareView.join(',')
  })

  await check(results, 13, '邀请链接会进入注册请求', () => {
    clearStoredInviteCode()
    expect(captureInviteCodeFromUrl('https://novelcomic.test/?invite=ncabc')).toBe('NCABC')
    expect(getStoredInviteCode()).toBe('NCABC')
    const forwards = sourceFiles().filter((file) => {
      const text = read(file)
      return text.includes('register-with-code') || text.includes('registerWithCode')
    })
    expect(forwards.length, '前端没有把本地邀请码交给注册接口，webhook 拿不到 unsafe_metadata.inviteCode').toBeGreaterThan(0)
    const body = forwards.map(read).join('\n')
    expect(body.includes('getStoredInviteCode') || body.includes('invite_code')).toBe(true)
    return 'invite stored and forwarded'
  })

  await check(results, 14, 'Share & Earn 复制邀请链接，Discord 和 Affiliate 只跳转', async () => {
    const link = buildShareEarnInviteLink('NCABC', 'https://novelcomic.test')
    expect(link).toBe('https://novelcomic.test/?invite=NCABC')
    await copyShareEarnInviteLink(link)
    expect(copied).toBe(link)
    const fetchCalls = calls.length
    openShareEarnExternal('https://discord.com')
    openShareEarnExternal('https://www.rewardful.com')
    expect(opened).toEqual(['https://discord.com', 'https://www.rewardful.com'])
    expect(calls.length).toBe(fetchCalls)
    const modal = read(join(srcRoot, 'components/home/navbar/items/share-earn-modal.tsx'))
    expect(modal).toContain('copyShareEarnInviteLink(inviteLink)')
    expect(modal).toContain('openShareEarnExternal(url)')
    expect(modal).toContain('Discord')
    expect(modal).toContain('Affiliate')
    expect(modal).not.toContain('fetch(')
    return link
  })

  await check(results, 15, '未登录读取 hooks 和 roles', async () => {
    calls.length = 0
    await fetchAgentCatalogHooks({ hookType: 'viral_hooks' })
    await fetchAgentCatalogRoles()
    const catalogCalls = calls.filter((call) => call.url.includes('/api/v3/agent-catalog/'))
    expect(catalogCalls[0]?.url).toContain('/api/v3/agent-catalog/hooks?')
    expect(catalogCalls[0]?.url).toContain('hook_type=viral_hooks')
    expect(catalogCalls[1]?.url).toContain('/api/v3/agent-catalog/roles?')
    expect(catalogCalls.every((call) => !call.headers?.Authorization)).toBe(true)
    return catalogCalls.map((call) => call.url).join(',')
  })

  await check(results, 16, '登录后打开 pending 并标记 shown', () => {
    const upgrade = read(join(srcRoot, 'features/billing/runtime/useUpgrade.tsx'))
    const client = read(join(srcRoot, 'api/modules/b2b-signal.ts'))
    expect(upgrade).toContain('getPendingB2BSignals')
    expect(upgrade).toContain('markB2BSignalShown')
    expect(client).toContain('/api/v2/b2b-signal/pending')
    expect(client).toContain('/api/v2/b2b-signal/shown')
    return 'pending then shown'
  })

  const reportPath = process.env.ACCEPT_FRONTEND_REPORT
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, JSON.stringify(results), 'utf8')
  }
  const failed = results.filter((item) => !item.ok)
  expect(failed, JSON.stringify(failed, null, 2)).toEqual([])
})
