# dsh-livestreamingcompanion

让 **DeepSeek Harness（DSH）** 里的 agent 真的去 B 站 / 抖音当主播：读弹幕、谢礼物、欢迎观众、记住老粉，
用自己的声音说话，还能自己开 Minecraft 一起玩。

本仓库包含两个 DSH 插件：

| 包 | 作用 |
| --- | --- |
| `packages/dsh-livestreamingcompanion` | 直播主体：舞台、弹幕、语音、点播、OBS 自动化 |
| `packages/dsh-game` | 游戏线：让她自己玩 Minecraft / 狼人杀 / 心跳文学部，画面接进直播舞台 |

## 效果

弹幕里刷「看看沧元图」，她就自己上 B 站搜、挑一集放上舞台，还顺手给出一句「美强惨本」的点评：

![她自己找的《沧元图》](docs/screenshots/01-直播姬-看视频.png)

换成《隧夜轮回（怨灵酒店）》也照放，字幕、弹幕、饭量计数同时走：

![放到舞台上的悬疑动画](docs/screenshots/02-自己找的悬疑动画.png)

看到紧张的地方她会自己接话：「我一边怕一……」：

![一边怕一边看](docs/screenshots/03-一边怕一边看.png)

> 截图来自 B 站直播（直播姬 + 舞台浏览器源）。素材版权归原作者所有，此处仅作功能演示。

## 游戏线：狼人杀与 Minecraft

`packages/dsh-game` 让她自己去玩，画面接进直播舞台就变成「她在玩给你看」。

### 狼人杀（插件自带）

九位 AI 娘围坐一桌：DeepSeek、Grok、Claude、GPT、Gemini、Qwen、Mistral、GLM、Kimi。发言、撒谎、投票、刀人、查验、用药，全是她们自己决定的；上帝视角能看到全部身份，每个人做决定前的**心声**用各自的声音念出来——嘴上说的和心里想的一起听。

![游戏库和狼人杀的入座面板](docs/images/library.jpg)

| | |
|---|---|
| ![夜里狼人刀人](docs/images/werewolf-night.jpg) | ![白天投票连线](docs/images/werewolf-vote.jpg) |
| ![轮到大肥鱼发言](docs/images/werewolf-speech.jpg) | ![结局翻牌](docs/images/werewolf-end.jpg) |

### Minecraft（Java 版，生存）

她自己进服务器玩：定目标、砍树、合成、挖矿、熔炼、打怪、天黑睡觉，还能按图纸盖房子、开地种庄稼、剪羊毛、搭传送门去下界。世界不会停下来等她，她说话的时候身体照样干活。

![方块世界里的大肥鱼](packages/dsh-game/assets/minecraft/cover.jpg)

插件会开一个真的 Minecraft 客户端当摄像机，旁观挂在她身上，窗口上叠着她的血量、饱食度和快捷栏；OBS 抓这个窗口，再叠一个浏览器源当 HUD，就是直播间看到的画面。

## 功能概览

- **舞台即网页**：海边小屋 / 深海 / 晚霞三套主题，舞台地址可直接当 OBS 浏览器源，也可给抖音直播伴侣做窗口源
- **弹幕与会话**：B 站走官方 WebSocket（自带 WBI 签名），抖音走真实浏览器桥（页面内截取），礼物 / SC / 上舰 / 进场都进她的注意力队列
- **语音**：豆包云（2.0 音色，带逐字字幕）或 **本地 GPT-SoVITS**（自训音色，音色更像本人）
- **点播视频**：观众说个大概，她只去抖音搜、挑、放上舞台；直播 Agent 不提供 B 站视频搜索和播放工具
- **记忆**：这一场和以前的观众都记着，常来的人会被认出来
- **OBS 自动化**：开播时自动建专用配置与场景（1080p30 / NVENC / CBR），推流结束自动收尾
- **控制台**：DSH 侧边栏「直播」，看舞台预览、换皮肤、开关播、模拟观众彩排、切音色

## 安装

需要 DSH 网页版 + pnpm + Node 22 以上。

```bash
pnpm install
pnpm -C packages/dsh-livestreamingcompanion build
pnpm -C packages/dsh-game build
```

把两个包链接进 DSH profile（示例：`~/.dsh/profiles/desktop/node_modules/`），并在该 profile 的
`package.json` 里加入依赖与 `dsh.profile.bundles`，重启 DSH 即可。

## 密钥

不要写进仓库。DSH 的凭据服务（`~/.dsh/.credentials.yaml` 的 `refs`）或控制台里填：

| 名字 | 用途 |
| --- | --- |
| `BILIBILI_COOKIE` | B 站登录态（SESSDATA / bili_jct / DedeUserID），读弹幕与开播 |
| `DOUYIN_COOKIE` | 抖音登录态，读抖音弹幕（匿名只能拿到 ttwid，进房常被拦） |
| `DOUBAO_TTS_API_KEY` | 火山引擎「大模型语音合成」新版控制台 API Key |

本地音色（可选）：装好 GPT-SoVITS，起 `api_v2.py`（默认 9880），在控制台「她的声音」里切到本地后端，
填参考音频与参考文本即可。

## 相对上游的改动

本仓库基于 [luckui/dsh-livestream](https://github.com/luckui/dsh-livestream) 与
[luckui/dsh-game](https://github.com/luckui/dsh-game)，在此之上做了：

- 新增 **语音后端开关**：豆包云 / 本地 GPT-SoVITS，本地后端走 `api_v2` 的 HTTP，不返回词级时间时字幕按音频时长均匀铺开
- 新增 **豆包 2.0 音色选择**（控制台下拉，7 个实测可用音色）
- 本地合成结果自动 **wav → mp3（96 kbps）**，单句体积降到约 1/5；舞台按内容魔数自动识别 mp3 / wav
- 抖音平台接入与设置项（房间号、Cookie、弹幕桥浏览器）
- 构建与部署脚本整理，库依赖锁定

## 已知问题

1. **舞台视频加载失败会让宿主进程退出**：`MediaError 2` 后插件在等 `Network.getResponseBody` 时超时崩溃。后续会加超时与降级。
2. **本地 GPT-SoVITS 的 `api_v2` 在本机过慢**（单句 100 秒以上，而直调 `infer.py` 仅数秒），仍待定位。
3. 抖音电脑开播目前只能走官方「直播伴侣」，普通账号没有第三方推流码；插件只负责画面与弹幕，不负责抖音推流。
4. 抖音的采集链路是「系统声音回环」，若直播伴侣开启监听，容易产生回声，需在调音台把麦克风 / 扬声器设为「仅输出不监听」。

## 许可

- **代码**：MIT（见 [LICENSE](LICENSE)），沿用上游版权声明。
- **大肥鱼素材**（`packages/dsh-livestreamingcompanion/assets/characters/dafeiyu/`）：**CC BY-NC-SA 4.0**，
  社区作品的衍生作品，署名与来源见该目录下的 `LICENSE.md`，仅限非商业使用。
- **GPT-SoVITS 权重与预训练模型**不在本仓库内。

## 致谢

- 上游插件作者：[luckui](https://github.com/luckui)（dsh-livestream、dsh-game）
- 大肥鱼音色训练素材：尹紫鹭幻想社（Bilibili）
- 语音：[火山引擎 · 大模型语音合成]、[GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)

## 免责

直播涉及平台规则、账号安全与内容合规，请自行确认所用账号、素材与直播内容符合各平台要求。
本仓库代码按现状提供，不附带任何担保。
