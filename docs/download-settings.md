# Bodhi download settings / 菩提下载设置

## English

### Install with Homebrew

```sh
brew tap bigduu/tap
brew trust bigduu/tap
brew install --cask bigduu/tap/bodhi
```

`brew trust` trusts this third-party tap and its future packages. The cask also installs the Jiandu and Nova command-line tools. Configure their MCP servers to use them in Bodhi.

If macOS blocks a manually downloaded DMG, open **System Settings → Privacy & Security → Open Anyway**. The current DMG is ad-hoc signed. See the [self-sign script](../scripts/self-sign-macos-app.sh) if you need to re-sign it locally.

The terminal installer puts a fresh macOS install in `~/Applications`. On APT-based Linux it needs Python 3 or `jq` and prompts for `sudo` and APT confirmation.

### Mirrors and proxies

If a component download stalls, open **Download settings** from the startup screen or **Versions and Updates**, choose a mirror or proxy, then retry. Bodhi can resume downloads if the source supports HTTP Range.

For a custom mirror, use an HTTPS base such as `https://mirror.example.com/bodhi/`. Append the original asset hostname and path to that base. Bamboo release files go under `/bodhi/github.com/bigduu/Bamboo-agent/releases/download/`. Lotus Next packages go under `/bodhi/registry.npmjs.org/@bigduu/lotus-next/-/`.

Proxy URLs support HTTP, HTTPS, SOCKS5, and SOCKS5H without credentials. Leave the field empty to use the environment proxy. Bodhi fetches the official component catalog through the configured proxy and verifies downloaded assets with SHA-256.

## 简体中文

### 用 Homebrew 安装

```sh
brew tap bigduu/tap
brew trust bigduu/tap
brew install --cask bigduu/tap/bodhi
```

`brew trust` 会信任这个第三方 tap 及以后发布的包。cask 也会安装简牍和 Nova 的命令行工具。在菩提里使用时，请配置对应的 MCP 服务。

手动下载的 DMG 如果被 macOS 拦截，可在「系统设置 → 隐私与安全性」点击「仍要打开」。当前 DMG 使用临时签名。需要在本机重新签名时，可参考[自签名脚本](../scripts/self-sign-macos-app.sh)。

终端安装脚本在 macOS 上首次安装时会把菩提放到 `~/Applications`。在使用 APT 的 Linux 上，脚本需要 Python 3 或 `jq`，并会提示 `sudo` 授权和 APT 确认。

### 镜像与代理

组件下载卡住时，在启动页或「版本与更新」打开「下载设置」，选择镜像或代理后重试。下载源支持 HTTP Range 时可以续传。

自定义镜像使用 HTTPS 地址，例如 `https://mirror.example.com/bodhi/`。把原始下载地址的域名和路径接在镜像地址后面。Bamboo 发布文件放在 `/bodhi/github.com/bigduu/Bamboo-agent/releases/download/`，Lotus Next 安装包放在 `/bodhi/registry.npmjs.org/@bigduu/lotus-next/-/`。

代理支持 HTTP、HTTPS、SOCKS5 和 SOCKS5H。地址中请省略账号和密码，留空则使用环境变量里的代理。菩提通过配置的代理读取官方组件目录，并校验下载文件的 SHA-256。
