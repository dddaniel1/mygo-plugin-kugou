# KuGou Music 插件（MyGo Music）

[MyGo Music](https://github.com/egoist/mygo-music) 的酷狗音乐插件：搜索、排行榜、歌单、专辑、歌词、扫码登录。

[![Install](https://img.shields.io/badge/install-mygo--music-blue)](mygo-music://install-plugin?repo=dddaniel1/mygo-plugin-kugou)

## 安装

- **在应用里安装**：设置 → 插件 → +，填入本仓库地址 `dddaniel1/mygo-plugin-kugou`
- **手动安装**：把整个文件夹放进 MyGo Music 的插件目录（设置 → 插件 → + → Show Plugins Folder）

需要 MyGo Music `0.1.8` 以上。

## 功能

- 搜索歌曲（含搜索建议）
- 酷狗排行榜（TOP500、飙升榜、新歌榜等）与榜单内歌曲
- 推荐歌单浏览、歌单详情（一次可取全量歌曲）
- 专辑页（封面、发行日期、歌曲列表）、收藏专辑
- 歌词（LRC，来自酷狗歌词库）
- 喜欢（本地保存）
- 酷狗二维码扫码登录：登录后按账号权益播放 VIP 歌曲，支持 320k / flac 音质
- 未登录也能播放免费歌曲（128k）

## 音质

设置里的「音质上限」（128 / 320 / flac）限制插件请求的最高音质；播放时 App 按其品质档位（standard / high / lossless）请求，在允许范围内取最接近的可用音质。320 / flac 需要登录酷狗账号，flac 通常还需 VIP。

## 限制

- 播放地址来自酷狗的移动端接口，未登录的 VIP 歌曲无法播放（插件会提示登录；账号非 VIP 时会尝试免费试听段）。
- 扫码登录用的是酷狗官方二维码登录流程，token 保存在插件本地存储中。
- 暂不支持：歌手页、评论、电台、播客、云歌单增删。

## 接口说明

请求走酷狗 Android 网关 `gateway.kugou.com`，签名算法为
`MD5(盐值 + 按 key 排序的 key=value 参数串 + 请求体 + 盐值)`
（参考 [MakcRe/KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi) 的逆向结果）。
二维码登录、歌词（krcs.kugou.com / lyrics.kugou.com）与试听接口（m.kugou.com）为公开接口。

## 文件

```
plugin.json         插件清单（权限、设置、侧边栏）
index.js            插件逻辑
locales/zh-CN.json  简体中文翻译
```

## License

[MIT](LICENSE)
