import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const reportDir = join(tmpdir(), 'novelcomic-accept-template-share-growth')
mkdirSync(reportDir, { recursive: true })
const publisherReport = join(reportDir, 'publisher.json')
const frontendReport = join(reportDir, 'frontend.json')

const steps = [
  [1, '未登录打开 /skills?tab=workflow，能看到 published 模板和分类，看不到草稿'],
  [2, '首页分类轨和导航预取用的是同一套分类数据'],
  [3, '模板卡片有 origin_flow_id 和 share_id 时，进入 /canvas/view/{flowId}?shareid='],
  [4, '预览只渲染分享快照。Use 得到新 flow_id，parent_flow_id 指向来源，运行状态被清掉'],
  [5, '只读画布的顶栏和 banner 也能另存一份项目'],
  [6, '编辑画布里的模板弹窗、模板工具和 Creator Skills 能把快照节点追加进当前图'],
  [7, '模型 list 和 dropdown-order 都能公开读。节点下拉按这个顺序显示，失败时退回本地数据'],
  [8, '内部 upsert 后，下一次公开读能看到新配置。只改排序时不改价格'],
  [9, '作者 POST /api/v3/share 只能分享自己的项目。打开后看到的是创建时的 nodes / edges'],
  [10, '无白名单可以不登录看 info。有白名单时只读页停在登录；visit 邮箱不匹配会被拒绝'],
  [11, '/canvas/?shareid= 把 owner 送到编辑页，把其他人送到只读页'],
  [12, 'app_and_workflow 会补读 app flow；没有 App 记录时分享页仍然能开'],
  [13, '/?invite= 注册后邀请人获得注册积分，且不超过 10 人。7 天内付费再获得付费积分。重复 webhook 不多发'],
  [14, 'Share & Earn 能复制邀请链接。Discord 和 Affiliate 只发生跳转'],
  [15, '未登录能读 published hooks 和 roles'],
  [16, 'B2B pending 只返回当前用户的弹窗。shown 之后不再展示。支付和 run 不因为 B2B 失败而失败'],
]

function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr })
    })
  })
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return [{ step: 0, name: path, ok: false, detail: error instanceof Error ? error.message : String(error) }]
  }
}

const python = join(root, 'novelcomic-publisher', '.venv', 'bin', 'python')
const publisher = await run(python, [join(root, 'scripts', 'accept-template-share-growth.py'), publisherReport])
const frontend = await run(
  'npx',
  ['vitest', 'run', '../scripts/accept-template-share-growth.frontend.test.tsx'],
  {
    cwd: join(root, 'novelcomic-frontend'),
    env: { ...process.env, ACCEPT_FRONTEND_REPORT: frontendReport },
  },
)

const checks = [...readJson(publisherReport), ...readJson(frontendReport)]
let failed = 0

console.log('模板、目录、分享、复制、邀请、Agent 目录、B2B 完整验收')
console.log('')

for (const [step, title] of steps) {
  const related = checks.filter((item) => item.step === step)
  const ok = related.length > 0 && related.every((item) => item.ok)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}. ${title}`)
  if (related.length === 0) {
    console.log('  - 没有执行到这一项')
  }
  for (const item of related) {
    console.log(`  - ${item.ok ? '通过' : '失败'} ${item.name}: ${item.detail}`)
  }
}

if (publisher.code !== 0 && !existsSync(publisherReport)) {
  console.log(publisher.stderr || publisher.stdout)
}
if (frontend.code !== 0 && checks.every((item) => item.step !== 2)) {
  const tail = `${frontend.stdout}\n${frontend.stderr}`.trim().split('\n').slice(-30)
  console.log('')
  console.log('前端验收进程输出：')
  console.log(tail.join('\n'))
}

console.log('')
console.log(failed === 0 ? `16/16 通过` : `${16 - failed}/16 通过，${failed} 项未通过`)
process.exit(failed === 0 && publisher.code === 0 ? 0 : 1)
