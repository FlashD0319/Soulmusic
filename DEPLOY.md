# 部署上线说明

本项目是纯静态网站：`index.html` + `app.js` + `style.css` + `recorder-worklet.js`。
`server.js` 只是本地开发用的静态服务器，上线时不需要运行它。

## 一句话结论

把项目根目录的静态文件托管到支持 HTTPS 的静态平台即可。
**必须使用 HTTPS**：浏览器麦克风（`getUserMedia`）只在安全上下文（HTTPS 或 localhost）下可用。

## 推荐方案：Cloudflare Pages（免费、自动 HTTPS、免备案）

### 方式 A：连接 Git 仓库（推荐，后续更新方便）

1. 把项目推到 GitHub（公开或私有仓库均可）。
2. 打开 [Cloudflare Pages](https://dash.cloudflare.com/) → Workers & Pages → Create → Pages → Connect to Git。
3. 选择仓库，部署设置：
   - Framework preset：`None`
   - Build command：留空
   - Build output directory：`/`
4. 点击 Save and Deploy，部署完成后会得到 `https://<你的项目>.pages.dev`。

### 方式 B：直接上传（最快，无需 Git）

1. Cloudflare Pages → Create → Pages → Upload assets。
2. 把项目文件夹拖进去（`index.html` 必须在根目录）。
3. 点击 Deploy，得到 `https://<你的项目>.pages.dev`。

## 备选：Netlify Drop（最傻瓜）

1. 打开 [Netlify Drop](https://app.netlify.com/drop)。
2. 把整个项目文件夹拖到页面上。
3. 几十秒后生成一个 `https://xxx.netlify.app` 链接。

## 国内稳定访问方案（需要备案域名）

如果访客主要在国内，且要求稳定、低延迟，建议：

1. 购买域名并完成 ICP 备案（通常 2–4 周）。
2. 腾讯云/阿里云「对象存储静态网站托管 + CDN」：
   - 上传静态文件到 COS/OSS，开启静态网站。
   - 绑定备案域名并配置 HTTPS 证书。
3. 或使用轻量应用服务器：
   - 上传项目文件后运行 `node server.js`。
   - 用 Caddy 或 Nginx 反向代理，并自动配置 HTTPS。

> 未备案的境外平台域名（如 `pages.dev`）可以访问，但国内速度不稳定，不适合正式运营。

## 部署后注意事项

- 访客首次使用需点击「启动引擎」授权麦克风。
- `recorder-worklet.js` 是相对路径加载，只要随根目录一起上传即可。
- Git 方式：`git push` 后平台会自动重新部署。
- 上传方式：更新文件后需要重新上传一次。
