# dsh-power-mode · 节能模式

侧边栏底部常驻的电源方案开关：点一下在「节能」和「高性能」两个方案之间切换，状态实时同步。

## 界面

- 位置：左侧栏底部、设置按钮左边（`sidebar.footer.action`）。
- 侧栏展开时是「图标 + 文字」的小胶囊，收起时只剩图标。
- 绿色叶子 = 节能模式已开启；琥珀色闪电 = 高性能已开启；灰色 = 其他电源方案。
- 悬停显示当前方案；点击切换，切换中图标上出现转圈。
- 状态每 20 秒轮询一次（页面隐藏时暂停），切回窗口也会立即刷新。

## 方案是怎么选的

插件不写死 GUID，每次读取 `powercfg /list`，按下面的顺序找方案：

1. **你显式指定的**（见下一节配置）。
2. **你自建的方案**：名字含「低功耗 / 节能 / 省电 / saver / power saving / battery」的当节能，
   含「高性能 / 游戏 / turbo / performance / ultimate」的当高性能。
   Windows 自带的三套方案（节能 / 高性能 / 平衡）不参与这一轮匹配，避免把你自定义的方案挤掉。
3. **Windows 自带方案**：节能 `a1841308-3541-4fab-bc81-f71556f20b4a`、
   高性能 `8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c`。

所以装到任何一台 Windows 上都能开箱即用；想用自己的方案名就按下面配一句。

## 指定自己的方案

两种方式，环境变量优先：

环境变量（值填 GUID 或方案名里的片段）：

```powershell
setx DSH_POWER_ECO   "d14d37e2-b783-4130-93c0-a9dc6ae686ca"
setx DSH_POWER_TURBO "1ef4720d-aa51-45ad-ac10-a094355701cd"
```

配置文件 `%USERPROFILE%\.dsh\power-mode.json`（`DSH_HOME` 设了就放那）：

```json
{ "eco": "低功耗", "turbo": "GameTurbo" }
```

值填 GUID 或名字片段都行，名字片段按「包含」匹配。改完不用重启，下一次切换 / 轮询就生效。

## 接口与工具

- `GET /api/power-mode/state` → `{ ok, mode, guid, scheme, at }`
- `POST /api/power-mode/set` `{ "mode": "eco" | "turbo" }`
- 工具 `power_mode`：`{ action: "status" | "eco" | "turbo" }`，和按钮共用同一份 `readState` / `setMode`。

## 自检

```powershell
node smoke.mjs
```

只做解析与识别逻辑的断言（含中文 GBK、英文界面、只有内置方案时的回落、显式配置），
最后读一次真实 `powercfg /list`；读不到（比如在无权限沙箱里）就跳过，不会切换任何方案。

## 权限说明

电源方案是机器级设置，切换执行 `powercfg /setactive`。DSH 宿主进程以当前用户身份运行，
实测 medium 完整性即可完成切换，不需要 UAC 提权。

## 手动兜底

```powershell
# 看当前
powercfg /getactivescheme
# 列出所有方案
powercfg /list
# 切到某个方案
powercfg /setactive <GUID>
```

## 卸载

```powershell
dsh plugin remove dsh-power-mode
```

（或在 DSH 插件管理里停用 / 卸载本 bundle。）
