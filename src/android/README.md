# src/android — WebView APK 工程

把控制台网页套一层原生 WebView 外壳，得到可在安卓安装的 App 图标。
**这不是把 exe 转 apk**：exe 是 Windows 程序，安卓跑不了。

```
app/src/main/
├── java/com/example/mcbotconsole/MainActivity.java   # WebView 全屏加载 console_url
└── res/
    ├── values/strings.xml              # ← 唯一必改项：console_url
    ├── layout/activity_main.xml
    └── xml/network_security_config.xml # 已允许 http 明文（否则连不了局域网 IP）
```

## 用法

1. 改 `app/src/main/res/values/strings.xml`：

```xml
<string name="console_url">http://192.168.1.50:8900</string>
```

- Tailscale：`http://100.x.x.x:8900`
- 同 WiFi：`http://192.168.x.x:8900`
- 手机自洽（后端在 Termux）：`http://127.0.0.1:8900`
- 公网隧道：`https://xxxx.ngrok-free.dev`

2. Android Studio 打开本目录 → Gradle 同步 → Run；
3. 分发：Build → Generate Signed Bundle / APK → APK → 签名。

不装开发环境也行：用任意 "Website → APK" 在线工具，填 URL 直接下载 APK。

## 注意

- 后端必须已在跑，且对外形态监听 `0.0.0.0`（手机自洽则用 `127.0.0.1`）；
- 走公网隧道时后端**必须**设 `CONSOLE_TOKEN`；
- 工程只做"全屏加载网页"，不缓存、不注入 JS，改 UI 请改 `src/console/index.html`。

选型建议见 [../../docs/04-移动端控制台.md](../../docs/04-移动端控制台.md)。
