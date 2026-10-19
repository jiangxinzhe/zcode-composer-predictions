# ZCode Composer Predictions

在 ZCode 桌面客户端的输入框里显示“下一句建议”：一轮回复结束后，如果草稿为空，输入框里会出现灰色提示；按 **Tab** 接受，按 **Esc** 忽略。思路参照 DSH 的 `dsh-plugin-composer-predictions`，但 ZCode 的插件清单没有客户端 UI 能力，所以这是一个**客户端注入 mod**，不是插件市场里的插件。

## 它做什么

- 监听 ZCode 当前窗口的会话，等待本轮 assistant 消息 `finish == "stop"`；
- 读取本地 `~/.zcode/cli/db/db.sqlite` 里最近几轮对话（只读）；
- 用当前会话的 provider/model（或你在配置里指定的模型）请求一条“下一句”；
- 把结果画进空输入框，Tab 写入 Lexical 草稿，Esc/输入/切会话/关闭开关都会清除。

每次建议会增加一次模型请求。默认只在草稿为空且预测开关打开时请求；如果本轮结束时你已经在输入，或者窗口里没有空草稿，就不会花这次请求。

## 安装

要求：Windows 或 macOS 上的 ZCode 桌面客户端，Python 3.8+。当前只在 Windows + ZCode 3.15.3 上实测。

```bash
cd zcode-composer-predictions
python install.py
```

安装器会：

1. 探测 `app.asar`（默认 `D:\ZCode\resources\app.asar`）；
2. 把运行时复制到 `~/.zcode/zcode-composer-predictions/`；
3. 在 `app.asar` 的主入口 `out/main/index.js` 尾部追加一行 loader 的 dynamic import；
4. 生成 `config.json`（不会覆盖已有配置）。

完成后**完全退出并重启 ZCode**。如果安装时 ZCode 正在运行，Windows 可能不允许替换被占用的 `app.asar`。这时安装器会启动一个独立的 finalizer（`finalize_on_exit.py`）监视 ZCode 退出：

1. 正常退出 ZCode；
2. **等 5 秒左右**再重新打开（给 finalizer 时间完成替换）；
3. 重开后建议功能生效。

如果重开后没有生效，说明 finalizer 没赶上。双击运行时目录里的 `finalize.cmd`，或在 ZCode 完全退出后执行：

```bash
python "$HOME/.zcode/zcode-composer-predictions/patch_install.py" install --finalize
```

finalizer 的日志在 `~/.zcode/zcode-composer-predictions/finalize.log`。只要里面有 `patched app.asar successfully`，就说明 asar 已经替换完成。

### 第一次验证

1. 发一条短消息，等回复结束；
2. 点一下空的输入框，应该出现灰色建议；
3. 按 Tab 应填入草稿，按 Esc 应消失；
4. 输入任意字符，建议应消失。

日志在 `~/.zcode/zcode-composer-predictions/zcp.log`。窗口右下角的 ✦ 按钮是设置面板，也可以按 `Alt+P` 快速开关。

## 配置

`~/.zcode/zcode-composer-predictions/config.json`：

| 字段 | 说明 |
|---|---|
| `enabled` | 总开关，默认 `true` |
| `pythonPath` | 运行 helper 的 Python 绝对路径，安装器会写入当前解释器 |
| `dbDir` | 会话数据库目录；留空 = `~/.zcode/cli/db` |
| `predict.providerId` / `modelId` | 留空 = 跟随当前会话的模型；建议填一个便宜的 flash 模型 |
| `predict.maxChars` | 建议长度上限，默认 160 |
| `predict.maxTranscriptChars` | 发给模型的对话上限，默认 12000 字符 |
| `predict.timeoutMs` | 模型请求超时，默认 30 秒 |
| `debug` | 写入更详细的日志 |

指定便宜模型的例子（provider/model 必须存在于 ZCode 的 `provider_config.json`）：

```json
{
  "predict": {
    "providerId": "new-provider",
    "modelId": "cn:deepseek-v4.1-flash"
  }
}
```

helper 会从以下位置找 provider 配置：`ZCODE_DATA_BASE_DIR/.zcode/v2/provider_config.json`、`~/.zcode/v2/provider_config.json`、`~/.zcode/cli/config.json`。它是按 ZCode 自己的 provider 配置发请求，不经过 ZCode 的内部接口。

## 手工测试 helper

```bash
cd ~/.zcode/zcode-composer-predictions
python predict_helper.py status  --session sess_xxx --pretty
python predict_helper.py predict --session sess_xxx --dry-run --pretty   # 只看提示词，不调模型
```

`status` 返回 `state: complete` 才表示一轮已结束。`predict` 会实际请求模型。

## 卸载

```bash
python ~/.zcode/zcode-composer-predictions/patch_install.py remove
# 或
python install.py --remove
```

只剥离本工具的注入行，不影响其它工具（例如 token 用量状态栏）的注入行。加 `--purge` 会同时删除运行时目录。

ZCode 升级会用新的 `app.asar` 覆盖注入行，升级后重跑一次 `python install.py` 即可。

## 风险与边界

- **非官方注入**：修改 `app.asar` 属于客户端 mod，依赖当前 `EmbeddedAsarIntegrityValidation=0`；官方一旦启用完整性校验或改动入口结构，注入会失效。
- **升级即失效**：每次 ZCode 升级后需要重跑安装器。
- **隐私**：建议会把最近几轮对话发给所选 provider。不要把敏感项目的会话交给不可信的模型；可以随时用 ✦ 或 `Alt+P` 关闭。
- **成本**：每次建议 = 一次模型请求。默认跟随会话模型，建议在配置里换成便宜的 flash 模型。
- **远程会话**：v0.1 只支持本机 SQLite 里的会话；ZCode 连接远端 zcode-server 时本地库没有对话，不会出建议。
- **多窗口/分屏**：主进程按窗口的 active session 推送；输入框优先选当前聚焦的编辑器，其次是窗口里最靠下的编辑器。极端分屏布局可能选错输入框，先只用单窗口。
- **中文输入法**：组合输入期间不会显示或接受建议。

## 结构

```
install.py              安装/卸载入口（探测 asar、部署运行时、调 patch）
patch_install.py        asar 注入/剥离（复用 token 状态栏的 asar 读写思路）
finalize_on_exit.py     运行中无法替换 asar 时，等 ZCode 退出后完成替换
finalize.cmd            手动收尾入口（finalizer 没赶上时双击）
inject-main.cjs         Electron 主进程 loader：注入、会话跟随、DB 监听、调 helper
overlay.js              渲染进程 UI：ghost text、Tab/Esc、设置面板
predict_helper.py       读 SQLite、判断轮次、拼提示词、调 OpenAI/Anthropic 兼容接口
config.example.json     配置模板
test/                   单元测试与 composer 冒烟页
```

## 致谢 / License

- 交互概念来自 [boshihaihai/dsh-plugin-composer-predictions](https://github.com/boshihaihai/dsh-plugin-composer-predictions)（MIT）。
- asar 注入/重打包思路来自 [xhwxt/zcode-token-usage-statusbar](https://github.com/xhwxt/zcode-token-usage-statusbar)（MIT）。
- 本项目 MIT，见 `LICENSE`。
