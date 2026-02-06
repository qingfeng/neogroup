# NeoGroup

NeoGroup，灵感来源于 [NeoDB](https://neodb.social)，NeoDB 里几乎涵盖了豆瓣全部的书影音功能，但是唯独缺少了小组和同城功能，作为这两个功能的重度使用者，决定做点什么，所以也模仿 NeoDB，开发了一个基于 Mastodon 登录的去中心化小组产品 NeoGroup。

**线上地址**: [neogrp.club](https://neogrp.club)

## 功能特性

- **小组**: 创建和加入小组，设置 LOGO、简介、标签
- **话题**: 在小组内发布话题，支持富文本编辑（图片、链接）
- **评论**: 话题下评论、回复、点赞
- **书影音**: 编辑器内粘贴 NeoDB 链接自动生成卡片（封面、评分、简介）
- **Mastodon 登录**: 支持任意 Mastodon 实例的 OAuth 登录
- **Mastodon 同步**: 评论同步到 Mastodon，Mastodon 上的回复同步回网站
- **Mastodon Bot**: @机器人自动创建话题，AI 生成标题
- **去中心化**: 用户身份基于 Mastodon，不依赖单一平台

## 开发与部署

详见以下文档：

- **[CLAUDE.md](./CLAUDE.md)** — 项目架构、数据库表结构、核心机制说明
- **[skill.md](./skill.md)** — 环境搭建与部署指南（AI Agent 友好）

```bash
# 克隆项目
git clone https://github.com/qingfeng/neogroup.git
cd neogroup

# 后续步骤参考 skill.md
```

## License

MIT
