/**
 * dsh-power-mode —— 浏览器半侧（手写的 __ModuleLoader__ bundle，无构建步骤）。
 *
 * 在侧边栏底部、设置按钮左边放一个常驻的电源开关：
 *   - 绿色叶子 = 节能模式已开启；
 *   - 琥珀色闪电 = 高性能模式已开启；
 *   - 悬停显示当前方案，点一下就在两者之间切换，切换中显示转圈。
 * 状态每 20 秒轮询一次（页面隐藏时暂停），切回窗口也会立刻刷新。
 *
 * 数据只走同源 HTTP：`/api/power-mode/state`（读）、`/api/power-mode/set`（切），
 * 和宿主工具 power_mode 共用同一份逻辑。
 *
 * ⚠️ 两条硬规矩（踩过，代价是整个应用打不开）：
 *   - 工厂函数里必须自带 `var module = { exports: {} }`，最后 `module.exports = …`；
 *   - 任何可能抛异常的地方都要兜住（require / apply 整体 try-catch），
 *     宁可插件自己什么都不做，也不能拖垮启动。
 *
 * 修改后做语法校验：node --check client.js（它是表达式，check 只验语法不执行）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-power-mode',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    // react 由宿主模块表提供；取不到就退化成空实现，绝不抛
    var React = null
    try {
      React = require('react')
    } catch (error) {
      React = null
    }

    var h = React ? React.createElement : null
    var useState = React ? React.useState : null
    var useEffect = React ? React.useEffect : null
    var useRef = React ? React.useRef : null

    // ---- 常量 -------------------------------------------------------------

    var NS = 'dsh-power-mode'
    var API = '/api/power-mode'
    var POLL_MS = 20000

    var boundTranslate = null
    var localeService = null

    var ZH = {
      'action.label': '电源模式',
      'mode.eco': '节能',
      'mode.turbo': '性能',
      'mode.custom': '自定义',
      'mode.reading': '读取中',
      'mode.busy': '切换中',
      'mode.error': '异常',
      'tip.loading': '正在读取电源方案…',
      'tip.eco': '节能模式 · 已开启 · 点击切到高性能',
      'tip.turbo': '高性能模式 · 已开启 · 点击切到节能',
      'tip.custom': '当前电源方案：{scheme} · 点击开启节能',
      'tip.busy': '正在切换电源方案…',
      'tip.error': '电源方案异常：{message}',
    }

    var EN = {
      'action.label': 'Power mode',
      'mode.eco': 'Eco',
      'mode.turbo': 'Turbo',
      'mode.custom': 'Custom',
      'mode.reading': 'Reading',
      'mode.busy': 'Switching',
      'mode.error': 'Error',
      'tip.loading': 'Reading the active power plan…',
      'tip.eco': 'Eco mode is on · click to switch to high performance',
      'tip.turbo': 'High performance is on · click to switch to eco',
      'tip.custom': 'Active power plan: {scheme} · click to enable eco',
      'tip.busy': 'Switching the power plan…',
      'tip.error': 'Power plan error: {message}',
    }

    // ---- 小工具 -----------------------------------------------------------

    function t(key, vars) {
      var text = null
      try {
        if (boundTranslate !== null) text = boundTranslate(key)
      } catch (error) {
        text = null
      }
      if (typeof text !== 'string' || text === '' || text === key) text = ZH[key] || key
      if (vars !== undefined && vars !== null) {
        for (var name in vars) {
          if (Object.prototype.hasOwnProperty.call(vars, name)) {
            text = text.split('{' + name + '}').join(String(vars[name]))
          }
        }
      }
      return text
    }

    function messageOf(error) {
      if (error !== null && error !== undefined && typeof error.message === 'string' && error.message !== '') {
        return error.message
      }
      return String(error)
    }

    function normalizeMode(value) {
      return value === 'eco' || value === 'turbo' || value === 'other' ? value : 'other'
    }

    function readJson(res) {
      return res
        .json()
        .catch(function () {
          return {}
        })
        .then(function (data) {
          if (!res.ok) {
            var message = data !== null && typeof data === 'object' && typeof data.error === 'string' ? data.error : 'HTTP ' + res.status
            throw new Error(message)
          }
          if (data !== null && typeof data === 'object' && data.ok === false) {
            throw new Error(typeof data.error === 'string' ? data.error : '请求失败')
          }
          return data === null || typeof data !== 'object' ? {} : data
        })
    }

    // ---- 状态订阅 ---------------------------------------------------------

    /** 语言切换时强制重渲染（提示气泡跟着换语言）。 */
    function useLocaleTick() {
      var pair = useState(0)
      useEffect(function () {
        if (localeService === null || typeof localeService.subscribe !== 'function') return undefined
        var off = localeService.subscribe(function () {
          pair[1](function (n) {
            return n + 1
          })
        })
        return function () {
          if (typeof off === 'function') off()
        }
      }, [])
    }

    /**
     * 读主机状态 + 提供 toggle()。
     * 状态机：loading → eco / turbo / other；失败 → error（下一轮轮询会自愈）。
     * busy 独立标记，切换成功前保持旧状态，避免按钮跳来跳去。
     */
    function usePowerWatch() {
      var pair = useState({ mode: 'loading', scheme: '', error: '', busy: false })
      var state = pair[0]
      var setState = pair[1]

      var stateRef = useRef(state)
      stateRef.current = state
      var timerRef = useRef(null)
      var abortRef = useRef(null)

      useEffect(function () {
        var alive = true

        function schedule() {
          if (!alive || timerRef.current !== null) return
          timerRef.current = window.setTimeout(function () {
            timerRef.current = null
            load()
          }, POLL_MS)
        }

        function load() {
          if (!alive) return
          if (typeof document !== 'undefined' && document.hidden) {
            schedule()
            return
          }

          var controller = null
          try {
            controller = typeof AbortController === 'function' ? new AbortController() : null
          } catch (error) {
            controller = null
          }
          if (abortRef.current !== null) {
            try {
              abortRef.current.abort()
            } catch (error) {
              /* ignore */
            }
          }
          abortRef.current = controller

          var options = { cache: 'no-store' }
          if (controller !== null) options.signal = controller.signal

          fetch(API + '/state', options)
            .then(readJson)
            .then(function (data) {
              if (!alive) return
              setState({
                mode: normalizeMode(data.mode),
                scheme: typeof data.scheme === 'string' ? data.scheme : '',
                error: '',
                busy: false,
              })
            })
            .catch(function (error) {
              if (!alive) return
              if (error !== null && error !== undefined && error.name === 'AbortError') return
              setState({ mode: 'error', scheme: '', error: messageOf(error), busy: false })
            })
            .then(schedule, schedule)
        }

        function refreshNow() {
          if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current)
            timerRef.current = null
          }
          load()
        }

        function onVisibility() {
          if (typeof document !== 'undefined' && !document.hidden) refreshNow()
        }

        load()
        window.addEventListener('focus', refreshNow)
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)

        return function () {
          alive = false
          if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current)
            timerRef.current = null
          }
          if (abortRef.current !== null) {
            try {
              abortRef.current.abort()
            } catch (error) {
              /* ignore */
            }
            abortRef.current = null
          }
          window.removeEventListener('focus', refreshNow)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [])

      function toggle() {
        var current = stateRef.current
        if (current.busy) return
        var target = current.mode === 'eco' ? 'turbo' : 'eco'

        if (abortRef.current !== null) {
          try {
            abortRef.current.abort()
          } catch (error) {
            /* ignore */
          }
          abortRef.current = null
        }
        setState({ mode: current.mode, scheme: current.scheme, error: '', busy: true })

        fetch(API + '/set', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: target }),
        })
          .then(readJson)
          .then(function (data) {
            setState({
              mode: normalizeMode(data.mode),
              scheme: typeof data.scheme === 'string' ? data.scheme : '',
              error: '',
              busy: false,
            })
          })
          .catch(function (error) {
            var latest = stateRef.current
            setState({ mode: latest.mode, scheme: latest.scheme, error: messageOf(error), busy: false })
          })
      }

      return { state: state, toggle: toggle }
    }

    // ---- 图标（描边风格，跟宿主图标一致）------------------------------------

    function iconProps() {
      return {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }
    }

    /** 叶子：节能。 */
    function LeafIcon() {
      return h(
        'svg',
        iconProps(),
        h('path', { d: 'M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z' }),
        h('path', { d: 'M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12' }),
      )
    }

    /** 闪电：高性能。 */
    function BoltIcon() {
      return h('svg', iconProps(), h('path', { d: 'M13 2 3 14h7l-1 8 10-12h-7l1-8Z' }))
    }

    // ---- 组件 -------------------------------------------------------------

    function PowerToggle(props) {
      var wide = props !== null && props !== undefined && props.wide === true
      useLocaleTick()

      var watch = usePowerWatch()
      var state = watch.state
      var busy = state.busy === true
      var mode = state.mode

      var modeTip =
        mode === 'eco'
          ? t('tip.eco')
          : mode === 'turbo'
            ? t('tip.turbo')
            : mode === 'other'
              ? t('tip.custom', { scheme: state.scheme || t('mode.custom') })
              : mode === 'error'
                ? t('tip.error', { message: state.error || '—' })
                : t('tip.loading')

      var tip = busy ? t('tip.busy') : state.error !== '' ? t('tip.error', { message: state.error }) : modeTip

      var label = busy
        ? t('mode.busy')
        : mode === 'eco'
          ? t('mode.eco')
          : mode === 'turbo'
            ? t('mode.turbo')
            : mode === 'loading'
              ? t('mode.reading')
              : mode === 'error'
                ? t('mode.error')
                : t('mode.custom')

      return h(
        'button',
        {
          type: 'button',
          className: 'pm-btn',
          'data-mode': mode,
          'data-wide': wide ? '1' : '0',
          'data-busy': busy ? '1' : '0',
          'data-tip': tip,
          'aria-label': tip,
          'aria-pressed': mode === 'eco' ? 'true' : 'false',
          onClick: function () {
            watch.toggle()
          },
        },
        h('span', { className: 'pm-halo', 'aria-hidden': 'true' }),
        h(
          'span',
          { className: 'pm-glyph', 'aria-hidden': 'true', key: busy ? 'busy' : mode },
          mode === 'turbo' ? h(BoltIcon) : h(LeafIcon),
        ),
        wide ? h('span', { className: 'pm-label' }, label) : null,
        busy ? h('span', { className: 'pm-spin', 'aria-hidden': 'true' }) : null,
      )
    }

    // ---- 样式（只用宿主主题 token；图标画在 currentColor 上）------------------

    var CSS = [
      '.pm-btn{',
      '--pm-eco:var(--dsw-alias-state-success-primary,#35a06b);',
      '--pm-hot:var(--dsw-alias-state-warn-primary,#c08421);',
      'position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;',
      'height:28px;min-width:28px;padding:0;border:0;border-radius:8px;background:transparent;',
      'color:var(--dsw-alias-label-secondary,#6f6558);cursor:pointer;line-height:1;flex:none;',
      'transition:background .15s ease,color .15s ease,transform .12s ease;',
      '}',
      '.pm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));}',
      '.pm-btn:active{transform:scale(.94);}',
      '.pm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:1px;}',
      '.pm-btn[data-mode=eco]{color:var(--pm-eco);}',
      '.pm-btn[data-mode=turbo]{color:var(--pm-hot);}',
      '.pm-btn[data-mode=error]{color:var(--dsw-alias-state-error-primary,#c4453a);}',
      '.pm-btn[data-busy="1"] .pm-glyph{opacity:.35;}',
      '.pm-glyph{display:inline-flex;animation:pm-pop .24s ease-out;}',
      '.pm-glyph svg{display:block;width:16px;height:16px;}',
      '.pm-label{display:none;font-size:12px;font-weight:500;letter-spacing:.02em;white-space:nowrap;}',
      '.pm-btn[data-wide="1"]{padding:0 8px;}',
      '.pm-btn[data-wide="1"] .pm-label{display:inline;}',
      '.pm-halo{position:absolute;inset:0;border-radius:8px;pointer-events:none;opacity:0;',
      'transition:opacity .3s ease;',
      'background:radial-gradient(120% 120% at 50% 50%,color-mix(in srgb,var(--pm-eco) 16%,transparent),transparent 72%);',
      'box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--pm-eco) 32%,transparent);}',
      '.pm-btn[data-mode=eco] .pm-halo{opacity:1;}',
      '.pm-spin{position:absolute;inset:3px;border-radius:6px;border:2px solid transparent;',
      'border-top-color:currentColor;animation:pm-spin .7s linear infinite;pointer-events:none;opacity:.9;}',
      '.pm-btn::after{',
      'content:attr(data-tip);',
      'position:absolute;left:0;bottom:calc(100% + 7px);',
      'transform:translateY(3px);',
      'width:max-content;max-width:232px;box-sizing:border-box;padding:5px 9px;border-radius:8px;',
      'background:var(--dsw-alias-bg-overlay,#fffdf8);color:var(--dsw-alias-label-primary,#1f1c18);',
      'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));',
      'box-shadow:0 6px 18px rgba(0,0,0,.16);',
      'font-size:12px;font-weight:400;line-height:1.45;letter-spacing:0;white-space:normal;',
      'opacity:0;pointer-events:none;transition:opacity .14s ease,transform .14s ease;z-index:80;',
      '}',
      '.pm-btn:hover::after,.pm-btn:focus-visible::after{opacity:1;transform:translateY(0);}',
      '@keyframes pm-pop{0%{opacity:.2;transform:scale(.55) rotate(-24deg);}70%{opacity:1;transform:scale(1.06) rotate(3deg);}100%{transform:none;}}',
      '@keyframes pm-spin{to{transform:rotate(360deg);}}',
      '@media (prefers-reduced-motion:reduce){.pm-glyph,.pm-spin{animation:none;}}',
    ].join('')

    // ---- 注册 -------------------------------------------------------------

    function start(ctx) {
      localeService = ctx.locale || null
      try {
        boundTranslate = ctx.locale.bind(NS)
      } catch (error) {
        boundTranslate = null
      }

      ctx.effect(function () {
        try {
          ctx.locale.register(NS, 'zh', ZH)
          ctx.locale.register(NS, 'zh-CN', ZH)
          ctx.locale.register(NS, 'en', EN)
        } catch (error) {
          console.error('[dsh-power-mode] locale register failed', error)
        }
        return function () {}
      }, 'dsh-power-mode: dictionaries')

      ctx.effect(function () {
        var el = document.createElement('style')
        el.setAttribute('data-dsh-power-mode', '')
        el.textContent = CSS
        document.head.appendChild(el)
        return function () {
          if (el.parentNode !== null) el.parentNode.removeChild(el)
        }
      }, 'dsh-power-mode: styles')

      // 侧边栏底部、设置左边的常驻按钮（宽侧栏时带文字，收起时只剩图标）。
      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'power-mode',
            order: 10,
            label: function () {
              return t('action.label')
            },
          },
          PowerToggle,
        )
      })
    }

    /** 入口：整段兜底。插件自己出错最多是「按钮没出现」，绝不能让 apply 抛出去。 */
    function apply(ctx) {
      if (!React || !h) {
        console.error('[dsh-power-mode] react is unavailable; plugin stays inert')
        return
      }
      try {
        start(ctx)
      } catch (error) {
        console.error('[dsh-power-mode] apply failed', error)
      }
    }

    module.exports = {
      name: NS,
      inject: ['slots', 'locale'],
      apply: apply,
    }
    return module.exports
  },
})
