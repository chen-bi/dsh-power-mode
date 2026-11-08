// 电源方案插件的自检：解析、识别、回落。不切换任何方案。
// 用法：node smoke.mjs
import { __test } from './index.js'

const { parseSchemeList, pickScheme, resolveSchemes, BUILTIN_SCHEMES } = __test

let passed = 0
let failed = 0

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed += 1
    console.log(`ok   ${label}`)
  } else {
    failed += 1
    console.log(`FAIL ${label}\n     期望 ${JSON.stringify(expected)}\n     实际 ${JSON.stringify(actual)}`)
  }
}

// ---- 1. 解析：中文名、英文套括号、结尾 * 标记 -----------------------------
const sample = [
  '',
  '现有电源使用方案 (* Active)',
  '-----------------------------------',
  '电源方案 GUID: 1ef4720d-aa51-45ad-ac10-a094355701cd  (GameTurbo (High Performance)) *',
  '电源方案 GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (平衡)',
  '电源方案 GUID: 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c  (高性能)',
  '电源方案 GUID: a1841308-3541-4fab-bc81-f71556f20b4a  (节能)',
  '电源方案 GUID: d14d37e2-b783-4130-93c0-a9dc6ae686ca  (大肥鱼 低功耗)',
].join('\r\n')

const list = parseSchemeList(sample)
check('解析条数', list.length, 5)
check('嵌套括号取完整名', list[0].name, 'GameTurbo (High Performance)')
check('中文名不乱码', list[4].name, '大肥鱼 低功耗')
check('GUID 小写', list[2].guid, '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c')

// ---- 2. 自动识别：优先用户自建方案，内置方案不抢位 -----------------------
check('eco 选中用户方案', pickScheme('eco', list, { eco: '', turbo: '' }).guid, 'd14d37e2-b783-4130-93c0-a9dc6ae686ca')
check('turbo 选中用户方案', pickScheme('turbo', list, { eco: '', turbo: '' }).guid, '1ef4720d-aa51-45ad-ac10-a094355701cd')

// 只有 Windows 自带方案的机器：回落到内置 GUID
const builtinOnly = list.filter((item) => !['d14d37e2-b783-4130-93c0-a9dc6ae686ca', '1ef4720d-aa51-45ad-ac10-a094355701cd'].includes(item.guid))
check('只有内置方案时 eco 回落', pickScheme('eco', builtinOnly, { eco: '', turbo: '' }), {
  guid: 'a1841308-3541-4fab-bc81-f71556f20b4a',
  name: '节能',
})
check('只有内置方案时 turbo 回落', pickScheme('turbo', builtinOnly, { eco: '', turbo: '' }), {
  guid: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c',
  name: '高性能',
})

// 英文系统 + 一个自定义游戏方案
const english = parseSchemeList(
  'Power Scheme GUID: 1ef4720d-aa51-45ad-ac10-a094355701cd  (GameTurbo (High Performance)) *\r\nPower Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)',
)
check('英文界面识别 turbo', pickScheme('turbo', english, { eco: '', turbo: '' }).guid, '1ef4720d-aa51-45ad-ac10-a094355701cd')

// ---- 3. 显式配置：GUID / 名字片段 --------------------------------------
check('配置 GUID', pickScheme('eco', list, { eco: 'A1841308-3541-4FAB-BC81-F71556F20B4A', turbo: '' }).guid, 'a1841308-3541-4fab-bc81-f71556f20b4a')
check('配置名字片段', pickScheme('turbo', list, { eco: '', turbo: 'GameTurbo' }).guid, '1ef4720d-aa51-45ad-ac10-a094355701cd')
check('配置了列表里没有的 GUID 也照用', pickScheme('eco', list, { eco: '00000000-0000-0000-0000-000000000000', turbo: '' }), {
  guid: '00000000-0000-0000-0000-000000000000',
  name: '00000000-0000-0000-0000-000000000000',
})

// ---- 4. 真机联调：读一次真实方案表（沙箱里 powercfg 可能被拦，跳过） ------
try {
  const schemes = await resolveSchemes()
  if (schemes.list.length === 0) {
    console.log('skip 真实 powercfg 没有输出，跳过联调')
  } else {
    check('真机 eco 有名字', typeof schemes.eco.name === 'string' && schemes.eco.name !== '', true)
    check('真机 turbo 有名字', typeof schemes.turbo.name === 'string' && schemes.turbo.name !== '', true)
    check('真机 eco GUID 在内置表里或已识别', schemes.eco.guid.length, 36)
    console.log(`     真机结果：eco=${schemes.eco.name} (${schemes.eco.guid}) / turbo=${schemes.turbo.name} (${schemes.turbo.guid})`)
  }
} catch (error) {
  console.log(`skip 真实 powercfg 不可用，跳过联调：${error.message}`)
}

console.log(`\n${passed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1
