/**
 * dsh-power-mode —— Host 半侧（手写插件，无构建步骤）。
 *
 * 一件事：在「节能」和「高性能」两个 Windows 电源方案之间切换。
 *   1. 注册 /api/power-mode/state（读）和 /api/power-mode/set（切），给网页侧边栏按钮用；
 *   2. 注册 power_mode 工具，助手在聊天里也能走同一套逻辑；
 *   3. 切换靠 powercfg；方案 GUID 不写死 —— 按名字自动识别，认不出来再退到 Windows 自带方案。
 *
 * 权限说明：电源方案是机器级设置。DSH 宿主进程以当前用户身份运行，
 * 实测 medium 完整性即可执行 `powercfg /setactive`，不需要 UAC 提权。
 *
 * 修改后做语法校验：node --check index.js（ESM 用 node --input-type=module --check 或直接 import）。
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const API_PREFIX = '/api/power-mode'
const TOOL_NAME = 'power_mode'

/**
 * 两个电源方案不在代码里写死，按这个顺序找：
 *   1. 显式配置：环境变量 DSH_POWER_ECO / DSH_POWER_TURBO，
 *      或 $DSH_HOME/power-mode.json（{"eco": "...", "turbo": "..."}）；
 *      值可以是完整 GUID，也可以是方案名（含这段文字即可）。
 *   2. 自动识别：在 `powercfg /list` 里按名字找（低功耗 / 节能 / 高性能 / 游戏 …）。
 *   3. 兜底：Windows 自带的「节能」「高性能」方案 GUID。
 */
const BUILTIN_SCHEMES = {
  eco: 'a1841308-3541-4fab-bc81-f71556f20b4a',
  turbo: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c',
}

/** Windows 自带的三套方案（节能 / 高性能 / 平衡）：自动识别时优先让位给用户自建的方案。 */
const BUILTIN_GUIDS = new Set([
  BUILTIN_SCHEMES.eco,
  BUILTIN_SCHEMES.turbo,
  '381b4222-f694-41f0-9685-ff5bb260df2e',
])

const FALLBACK_NAMES = {
  eco: '节能',
  turbo: '高性能',
}

/** 名字里出现这些词就认为是「节能」/「高性能」方案。 */
const NAME_HINTS = {
  eco: /低功耗|节能|省电|saver|power\s*saving|battery/i,
  turbo: /高性能|游戏|turbo|performance|ultimate/i,
}

const MODE_LABELS = {
  eco: '节能模式',
  turbo: '高性能模式',
  other: '自定义方案',
}

/** powercfg 输出里的方案 GUID；电源方案本身都以 GUID 标识，跟系统语言无关。 */
const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** 最近的读取结果，只做 1 秒级去抖（侧边栏轮询 + 切窗口回来时会连发）。 */
let stateCache = null

const TOOL_DESCRIPTION = `切换这台电脑的 Windows 电源方案（节能模式开关），和侧边栏「电源模式」按钮是同一套逻辑：
- action:"status"：查看当前电源方案；
- action:"eco"：切到节能方案（名字含「低功耗 / 节能」的那个，没有就用 Windows 自带「节能」）；
- action:"turbo"：切到高性能方案（名字含「高性能 / 游戏」的那个，没有就用 Windows 自带「高性能」）。
用户说「开节能模式 / 关节能模式」「切回性能」时用它；不确定当前状态就先 status。`

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'eco', 'turbo'],
      description: 'status 看当前方案 | eco 切到节能方案 | turbo 切回高性能方案',
    },
  },
  required: ['action'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    mode: { type: 'string' },
    scheme: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['ok', 'action', 'mode', 'scheme', 'message'],
}

/** 一段短文本内容块。 */
function textBlock(text) {
  return [{ type: 'text', text }]
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text, 'utf8')),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('请求体过大'))
        if (typeof req.destroy === 'function') req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        resolve(text === '' ? {} : JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** powercfg 在中文 Windows 上吐 GBK；按 GBK 解，解不了再退 latin1（GUID 是纯 ASCII，两种都安全）。 */
function decodeConsole(value) {
  if (!Buffer.isBuffer(value)) return String(value ?? '')
  try {
    const text = new TextDecoder('gbk').decode(value)
    if (text !== '') return text
  } catch {
    /* 运行时没有 GBK 编码表就退 latin1 */
  }
  return value.toString('latin1')
}

/**
 * 跑一次 powercfg。
 */
function execPowercfg(args) {
  return new Promise((resolve) => {
    execFile(
      'powercfg.exe',
      args,
      { timeout: 12000, windowsHide: true, encoding: 'buffer' },
      (error, stdout, stderr) => {
        const rawCode = error ? error.code : 0
        const code = typeof rawCode === 'number' ? rawCode : (rawCode === 'ENOENT' ? 127 : 1)
        resolve({
          code,
          stdout: decodeConsole(stdout),
          stderr: decodeConsole(stderr),
        })
      },
    )
  })
}

/** 从 `powercfg /list` 的输出里抠出 { guid, name } 列表（名字里允许再套括号）。 */
function parseSchemeList(text) {
  const list = []
  for (const line of text.split(/\r?\n/)) {
    const guidMatch = line.match(GUID_RE)
    if (guidMatch === null) continue
    const guid = guidMatch[0].toLowerCase()
    const rest = line.slice(line.indexOf(guidMatch[0]) + guidMatch[0].length)
    const open = rest.indexOf('(')
    const close = rest.lastIndexOf(')')
    const name = open !== -1 && close > open ? rest.slice(open + 1, close).trim() : ''
    list.push({ guid, name })
  }
  return list
}

/** 显式配置：环境变量优先，其次 $DSH_HOME/power-mode.json。 */
async function readOverrides() {
  const overrides = { eco: '', turbo: '' }
  const configPath = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'power-mode.json')

  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
    for (const mode of ['eco', 'turbo']) {
      if (typeof parsed?.[mode] === 'string') overrides[mode] = parsed[mode].trim()
    }
  } catch {
    /* 没配置 / 配置坏了都走自动识别 */
  }

  if (typeof process.env.DSH_POWER_ECO === 'string' && process.env.DSH_POWER_ECO !== '') {
    overrides.eco = process.env.DSH_POWER_ECO.trim()
  }
  if (typeof process.env.DSH_POWER_TURBO === 'string' && process.env.DSH_POWER_TURBO !== '') {
    overrides.turbo = process.env.DSH_POWER_TURBO.trim()
  }
  return overrides
}

/** 已解析的方案表，进程内缓存；powercfg 报错或用户改了方案时刷新。 */
let schemeCache = null

function pickScheme(mode, list, overrides) {
  const wanted = overrides[mode]
  if (wanted !== '') {
    const exact = list.find((item) => item.guid === wanted.toLowerCase())
    if (exact !== undefined) return exact
    const byName = list.find((item) => item.name !== '' && item.name.includes(wanted))
    if (byName !== undefined) return byName
    if (GUID_RE.test(wanted)) return { guid: wanted.toLowerCase(), name: wanted }
  }

  const hinted =
    list.find((item) => !BUILTIN_GUIDS.has(item.guid) && NAME_HINTS[mode].test(item.name)) ??
    list.find((item) => NAME_HINTS[mode].test(item.name))
  if (hinted !== undefined) return hinted

  const builtin = list.find((item) => item.guid === BUILTIN_SCHEMES[mode])
  if (builtin !== undefined) return builtin

  return { guid: BUILTIN_SCHEMES[mode], name: FALLBACK_NAMES[mode] }
}

async function resolveSchemes({ refresh = false } = {}) {
  if (schemeCache !== null && !refresh) return schemeCache

  const [overrides, listed] = await Promise.all([readOverrides(), execPowercfg(['/list'])])
  const list = parseSchemeList(listed.stdout)
  schemeCache = {
    eco: pickScheme('eco', list, overrides),
    turbo: pickScheme('turbo', list, overrides),
    list,
  }
  return schemeCache
}

/** 当前方案在列表里的真名；不在列表里就显示 GUID。 */
function schemeNameOf(guid, schemes) {
  const hit = schemes.list.find((item) => item.guid === guid)
  return hit !== undefined && hit.name !== '' ? hit.name : guid
}

async function readState() {
  const now = Date.now()
  if (stateCache !== null && now - stateCache.at < 1000) return stateCache.state

  const schemes = await resolveSchemes()
  const result = await execPowercfg(['/getactivescheme'])
  const match = result.stdout.match(GUID_RE)
  if (match === null) {
    throw new Error(`读取电源方案失败：${(result.stderr || result.stdout || 'powercfg 没有输出').trim()}`)
  }
  const guid = match[0].toLowerCase()
  const mode = guid === schemes.eco.guid ? 'eco' : guid === schemes.turbo.guid ? 'turbo' : 'other'
  const state = {
    mode,
    guid,
    scheme: mode === 'other' ? schemeNameOf(guid, schemes) : schemes[mode].name,
    at: new Date().toISOString(),
  }
  stateCache = { at: now, state }
  return state
}

async function setMode(mode) {
  if (mode !== 'eco' && mode !== 'turbo') throw new Error(`未知模式：${mode}`)

  let schemes = await resolveSchemes()
  const guid = schemes[mode].guid

  let result = await execPowercfg(['/setactive', guid])
  if (result.code !== 0) {
    // 方案可能刚被删掉或改了名：刷一次方案表再试一次
    schemes = await resolveSchemes({ refresh: true })
    const retryGuid = schemes[mode].guid
    if (retryGuid !== guid) {
      stateCache = null
      result = await execPowercfg(['/setactive', retryGuid])
    }
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.code}`).trim()
    throw new Error(`powercfg 切换失败：${detail}`)
  }

  stateCache = null
  const state = await readState()
  if (state.mode !== mode) {
    throw new Error(`切换后确认失败：当前仍是 ${state.scheme}`)
  }
  return state
}

function modeLabel(mode) {
  return MODE_LABELS[mode] ?? MODE_LABELS.other
}

function toolValue(action, state, message) {
  return {
    ok: true,
    action,
    mode: state.mode,
    scheme: state.scheme,
    message,
  }
}

/** 只给 smoke.mjs 用的内部钩子，不参与插件运行时。 */
export const __test = { parseSchemeList, pickScheme, resolveSchemes, BUILTIN_SCHEMES }

export const name = 'dsh-power-mode'
export const inject = ['tools', 'webServer']

export function apply(ctx) {
  // ---- 1. 同源接口：侧边栏按钮的状态与切换 -------------------------------
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const route = url.pathname.slice(API_PREFIX.length) || '/'

            if (route === '/state' && (req.method === 'GET' || req.method === 'HEAD')) {
              const state = await readState()
              return sendJson(res, 200, { ok: true, ...state })
            }

            if (route === '/set' && req.method === 'POST') {
              let body = null
              try {
                body = await readBody(req)
              } catch {
                return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
              }
              const mode = typeof body?.mode === 'string' ? body.mode : ''
              if (mode !== 'eco' && mode !== 'turbo') {
                return sendJson(res, 400, { ok: false, error: 'mode 只能是 eco 或 turbo' })
              }
              const state = await setMode(mode)
              return sendJson(res, 200, { ok: true, ...state })
            }

            return sendJson(res, 404, { ok: false, error: 'not found' })
          } catch (error) {
            try {
              sendJson(res, 500, { ok: false, error: messageOf(error) })
            } catch {
              /* 响应已断开 */
            }
          }
        },
      }),
    'dsh-power-mode: state api',
  )

  // ---- 2. 工具：助手也能切（和按钮同一套 readState / setMode）----------
  ctx.effect(
    () =>
      ctx.tools.register({
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        parameters: PARAMETERS,
        output: {
          schema: OUTPUT_SCHEMA,
          render: (_args, value) => textBlock(typeof value?.message === 'string' ? value.message : ''),
        },
        presentCall: (args) => ({
          card: 'generic',
          title: `电源模式 · ${args?.action === 'eco' ? '节能' : args?.action === 'turbo' ? '性能' : '状态'}`,
          kind: 'other',
        }),
        execute: async (args) => {
          const action = typeof args?.action === 'string' ? args.action : 'status'
          try {
            if (action === 'status') {
              const state = await readState()
              return toolValue(
                action,
                state,
                `当前电源方案：${state.scheme}（${modeLabel(state.mode)}），GUID ${state.guid}。`,
              )
            }
            if (action === 'eco' || action === 'turbo') {
              const state = await setMode(action)
              return toolValue(
                action,
                state,
                action === 'eco'
                  ? `已切到节能模式（${state.scheme}）。`
                  : `已切到高性能模式（${state.scheme}）。`,
              )
            }
            return {
              ok: false,
              action,
              mode: 'other',
              scheme: '',
              message: `未知 action：${action}（可用 status / eco / turbo）`,
            }
          } catch (error) {
            return {
              ok: false,
              action,
              mode: 'other',
              scheme: '',
              message: messageOf(error),
            }
          }
        },
      }),
    'dsh-power-mode: tool',
  )
}
