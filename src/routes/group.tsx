import { Hono } from 'hono'
import { eq, desc, sql, and } from 'drizzle-orm'
import type { AppContext } from '../types'
import { groups, groupMembers, topics, users, comments, authProviders } from '../db/schema'
import { Layout } from '../components/Layout'
import { generateId, truncate, now, getExtensionFromUrl, getContentType, resizeImage } from '../lib/utils'
import { postStatus } from '../services/mastodon'
import { deliverTopicToFollowers } from '../services/activitypub'

const group = new Hono<AppContext>()

// 按标签筛选小组
group.get('/tag/:tag', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const tag = decodeURIComponent(c.req.param('tag'))

  const allGroups = await db
    .select({
      id: groups.id,
      creatorId: groups.creatorId,
      name: groups.name,
      description: groups.description,
      tags: groups.tags,
      iconUrl: groups.iconUrl,
      createdAt: groups.createdAt,
      updatedAt: groups.updatedAt,
      memberCount: sql<number>`(SELECT COUNT(*) FROM group_member WHERE group_member.group_id = ${groups.id})`.as('member_count'),
    })
    .from(groups)
    .where(sql`${groups.tags} IS NOT NULL AND ${groups.tags} != ''`)

  const matchedGroups = allGroups.filter(g =>
    g.tags!.split(/\s+/).some(t => t === tag)
  )

  return c.html(
    <Layout user={user} title={`标签: ${tag}`} unreadCount={c.get('unreadNotificationCount')}>
      <div class="group-detail">
        <div class="group-content">
          <div class="section-header">
            <h2>标签「{tag}」的小组</h2>
          </div>
          {matchedGroups.length === 0 ? (
            <p class="no-content">暂无小组</p>
          ) : (
            <div class="tag-group-list">
              {matchedGroups.map((g) => (
                <div class="tag-group-item">
                  <img src={g.iconUrl || '/static/img/default-group.svg'} alt="" class="tag-group-icon" />
                  <div class="tag-group-info">
                    <a href={`/group/${g.id}`} class="tag-group-name">{g.name}</a>
                    {g.description && <p class="tag-group-desc">{truncate(g.description, 80)}</p>}
                    <span class="card-meta">{g.memberCount} 成员</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Layout>
  )
})

// 创建小组页面
group.get('/create', async (c) => {
  const user = c.get('user')
  if (!user) return c.redirect('/auth/login')

  return c.html(
    <Layout user={user} title="创建小组" unreadCount={c.get('unreadNotificationCount')}>
      <div class="new-topic-page">
        <div class="page-header">
          <h1>创建小组</h1>
        </div>
        <form action="/group/create" method="POST" enctype="multipart/form-data" class="topic-form">
          <div class="form-group">
            <label for="name">小组名称</label>
            <input type="text" id="name" name="name" placeholder="给小组取个名字" required />
          </div>
          <div class="form-group">
            <label for="icon">小组 LOGO</label>
            <input type="file" id="icon" name="icon" accept="image/*" />
            <p style="color: #999; font-size: 12px; margin-top: 5px;">支持 JPG、PNG、GIF、WebP 格式</p>
          </div>
          <div class="form-group">
            <label for="description">小组简介</label>
            <textarea id="description" name="description" rows={3} placeholder="介绍一下这个小组..."></textarea>
          </div>
          <div class="form-group">
            <label for="tags">分类标签 <span style="color: #999; font-weight: normal;">(空格分隔)</span></label>
            <input type="text" id="tags" name="tags" placeholder="如：电影 读书 音乐" />
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">创建小组</button>
            <a href="/" class="btn">取消</a>
          </div>
        </form>
      </div>
    </Layout>
  )
})

// 创建小组处理
group.post('/create', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  if (!user) return c.redirect('/auth/login')

  const body = await c.req.parseBody()
  const name = (body.name as string)?.trim()
  const description = (body.description as string)?.trim() || null
  const tags = (body.tags as string)?.trim() || null
  const iconFile = body.icon as File | undefined

  if (!name) return c.redirect('/group/create')

  const groupId = generateId()
  const timestamp = now()
  let iconUrl: string | null = null

  // 处理 LOGO 上传
  if (iconFile && iconFile.size > 0 && c.env.R2) {
    try {
      const buffer = await iconFile.arrayBuffer()
      const ext = getExtFromFile(iconFile.name, iconFile.type)
      const contentType = getContentType(ext)
      const key = `groups/${groupId}.${ext}`
      await c.env.R2.put(key, buffer, { httpMetadata: { contentType } })
      const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
      iconUrl = `${baseUrl}/r2/${key}`
    } catch (error) {
      console.error('Failed to upload group icon:', error)
    }
  }

  await db.insert(groups).values({
    id: groupId,
    creatorId: user.id,
    name,
    description,
    tags,
    iconUrl,
    createdAt: timestamp,
    updatedAt: timestamp,
  })

  // 创建者自动加入小组
  await db.insert(groupMembers).values({
    id: generateId(),
    groupId,
    userId: user.id,
    createdAt: timestamp,
  })

  return c.redirect(`/group/${groupId}`)
})

group.get('/:id', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const groupId = c.req.param('id')

  // 获取小组详情
  const groupResult = await db
    .select({
      id: groups.id,
      creatorId: groups.creatorId,
      name: groups.name,
      description: groups.description,
      iconUrl: groups.iconUrl,
      createdAt: groups.createdAt,
      creator: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      },
    })
    .from(groups)
    .innerJoin(users, eq(groups.creatorId, users.id))
    .where(eq(groups.id, groupId))
    .limit(1)

  if (groupResult.length === 0) {
    return c.notFound()
  }

  const groupData = groupResult[0]

  // 获取成员数
  const memberCountResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId))
  const memberCount = memberCountResult[0]?.count || 0

  // 检查当前用户是否是成员
  let isMember = false
  if (user) {
    const membership = await db
      .select()
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId))
      .where(eq(groupMembers.userId, user.id))
      .limit(1)
    isMember = membership.length > 0
  }

  // 检查当前用户是否是创建者（管理员）
  const isCreator = user && user.id === groupData.creatorId

  // 获取小组话题（包含评论数）
  const topicList = await db
    .select({
      id: topics.id,
      title: topics.title,
      createdAt: topics.createdAt,
      updatedAt: topics.updatedAt,
      user: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
      },
      commentCount: sql<number>`(SELECT COUNT(*) FROM comment WHERE comment.topic_id = ${topics.id})`.as('comment_count'),
    })
    .from(topics)
    .innerJoin(users, eq(topics.userId, users.id))
    .where(eq(topics.groupId, groupId))
    .orderBy(desc(topics.updatedAt))
    .limit(50)

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('zh-CN')
  }

  // 生成 metadata
  const description = groupData.description
    ? truncate(groupData.description, 160)
    : `${groupData.name} - NeoGroup 小组`
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const groupUrl = `${baseUrl}/group/${groupId}`

  return c.html(
    <Layout
      user={user}
      title={groupData.name}
      description={description}
      image={groupData.iconUrl}
      url={groupUrl}
      unreadCount={c.get('unreadNotificationCount')}
    >
      <div class="group-detail">
        <div class="group-header">
          <img src={resizeImage(groupData.iconUrl, 160) || '/static/img/default-group.svg'} alt="" class="group-icon" />
          <div class="group-info">
            <h1>{groupData.name}</h1>
            {groupData.description && (
              <p class="group-description">{groupData.description}</p>
            )}
            <div class="group-meta">
              <span>{memberCount} 成员</span>
              <span>创建者: {groupData.creator.displayName || groupData.creator.username}</span>
            </div>
            {groupData.tags && (
              <div class="group-tags">
                {groupData.tags.split(/\s+/).filter(Boolean).map(tag => (
                  <span class="group-tag">{tag}</span>
                ))}
              </div>
            )}
          </div>
          <div class="group-actions">
            {user && !isMember && (
              <form action={`/group/${groupId}/join`} method="POST">
                <button type="submit" class="btn btn-primary">加入小组</button>
              </form>
            )}
            {user && isMember && (
              <span class="member-badge">已加入</span>
            )}
            {isCreator && (
              <a href={`/group/${groupId}/settings`} class="btn" style="margin-left: 10px;">小组设置</a>
            )}
          </div>
        </div>

        <div class="group-content">
          <div class="group-topics">
            <div class="section-header">
              <h2>话题</h2>
              {user && isMember && (
                <a href={`/group/${groupId}/topic/new`} class="btn btn-primary">发布话题</a>
              )}
            </div>

            {topicList.length === 0 ? (
              <p class="no-content">暂无话题</p>
            ) : (
              <table class="topic-table">
                <thead>
                  <tr>
                    <th class="topic-table-title">讨论</th>
                    <th class="topic-table-author">作者</th>
                    <th class="topic-table-count">回复</th>
                    <th class="topic-table-date">最后回复</th>
                  </tr>
                </thead>
                <tbody>
                  {topicList.map((topic) => (
                    <tr key={topic.id}>
                      <td class="topic-table-title">
                        <a href={`/topic/${topic.id}`}>{topic.title}</a>
                      </td>
                      <td class="topic-table-author">
                        <a href={`/user/${topic.user.id}`}>
                          {topic.user.displayName || topic.user.username}
                        </a>
                      </td>
                      <td class="topic-table-count">{topic.commentCount}</td>
                      <td class="topic-table-date">{formatDate(topic.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </Layout>
  )
})

// 加入小组
group.post('/:id/join', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const groupId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  // 检查小组是否存在
  const groupResult = await db
    .select()
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1)

  if (groupResult.length === 0) {
    return c.notFound()
  }

  // 检查是否已加入
  const existing = await db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id)))
    .limit(1)

  if (existing.length === 0) {
    await db.insert(groupMembers).values({
      id: generateId(),
      groupId,
      userId: user.id,
      createdAt: new Date(),
    })
  }

  return c.redirect(`/group/${groupId}`)
})

// 发布话题页面
group.get('/:id/topic/new', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const groupId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  // 获取小组信息
  const groupResult = await db
    .select()
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1)

  if (groupResult.length === 0) {
    return c.notFound()
  }

  const groupData = groupResult[0]

  // 检查是否是成员
  const membership = await db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id)))
    .limit(1)

  if (membership.length === 0) {
    return c.redirect(`/group/${groupId}`)
  }

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  return c.html(
    <Layout user={user} title={`发布话题 - ${groupData.name}`} unreadCount={c.get('unreadNotificationCount')}>
      <link href="https://cdn.jsdelivr.net/npm/quill@2.0.2/dist/quill.snow.css" rel="stylesheet" />
      <div class="new-topic-page">
        <div class="page-header">
          <h1>发布新话题</h1>
          <p class="page-subtitle">发布到 <a href={`/group/${groupId}`}>{groupData.name}</a></p>
        </div>

        <form action={`/group/${groupId}/topic/new`} method="POST" class="topic-form" id="topic-form">
          <div class="form-group">
            <label for="title">标题</label>
            <input type="text" id="title" name="title" required placeholder="话题标题" />
          </div>

          <div class="form-group">
            <label>内容</label>
            <div id="editor"></div>
            <input type="hidden" id="content" name="content" />
          </div>

          <div class="form-option">
            <label class="checkbox-label">
              <input type="checkbox" name="syncMastodon" value="1" />
              同步发布到 Mastodon
            </label>
          </div>

          <div class="form-actions">
            <button type="submit" class="btn btn-primary">发布话题</button>
            <a href={`/group/${groupId}`} class="btn">取消</a>
          </div>
        </form>
      </div>

      <script src="https://cdn.jsdelivr.net/npm/quill@2.0.2/dist/quill.js"></script>
      <script dangerouslySetInnerHTML={{ __html: `
        // NeoDB 卡片内部 HTML
        function buildNeoDBCardInner(data) {
          var img = data.coverUrl ? '<img src="' + data.coverUrl + '" alt="" />' : '';
          var rating = data.rating ? '<span class="neodb-card-rating">\\u2b50 ' + data.rating + '</span>' : '';
          var meta = [];
          if (data.year) meta.push(data.year);
          if (data.genre && data.genre.length) meta.push(data.genre.slice(0, 3).join(', '));
          var metaHtml = meta.length ? '<span class="neodb-card-meta">' + meta.join(' / ') + '</span>' : '';
          var brief = data.brief ? '<span class="neodb-card-brief">' + data.brief.slice(0, 100) + (data.brief.length > 100 ? '...' : '') + '</span>' : '';
          return '<a href="' + data.url + '" target="_blank" rel="noopener">'
            + img
            + '<span class="neodb-card-info">'
            + '<span class="neodb-card-title">' + data.title + '</span>'
            + rating + metaHtml + brief
            + '</span></a>';
        }

        // 注册自定义 NeoDB 卡片 Blot
        var BlockEmbed = Quill.import('blots/block/embed');
        class NeoDBCardBlot extends BlockEmbed {
          static create(data) {
            var node = super.create();
            node.setAttribute('contenteditable', 'false');
            node.dataset.neodb = JSON.stringify(data);
            node.innerHTML = buildNeoDBCardInner(data);
            return node;
          }
          static value(node) {
            try { return JSON.parse(node.dataset.neodb); } catch(e) { return {}; }
          }
        }
        NeoDBCardBlot.blotName = 'neodb-card';
        NeoDBCardBlot.tagName = 'DIV';
        NeoDBCardBlot.className = 'neodb-card';
        Quill.register(NeoDBCardBlot);

        const quill = new Quill('#editor', {
          theme: 'snow',
          placeholder: '话题内容（可选）...',
          modules: {
            toolbar: [
              ['bold', 'italic', 'underline', 'strike'],
              ['blockquote', 'code-block'],
              [{ 'list': 'ordered'}, { 'list': 'bullet' }],
              ['link', 'image'],
              ['clean']
            ]
          }
        });

        // 图片上传处理
        quill.getModule('toolbar').addHandler('image', function() {
          const input = document.createElement('input');
          input.setAttribute('type', 'file');
          input.setAttribute('accept', 'image/*');
          input.click();
          input.onchange = async () => {
            const file = input.files[0];
            if (file) {
              await uploadImage(file);
            }
          };
        });

        // 添加 NeoDB 工具栏按钮
        (function() {
          var toolbarEl = document.querySelector('.ql-toolbar');
          var grp = document.createElement('span');
          grp.className = 'ql-formats';
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ql-neodb';
          btn.title = '插入 NeoDB 书影音链接';
          btn.addEventListener('click', function() {
            var url = prompt('请输入 NeoDB 链接（书影音游戏等）\\nhttps://neodb.social/movie/...');
            if (!url || !url.trim()) return;
            url = url.trim();
            if (!/neodb\\.social\\/(movie|book|tv|music|game|podcast|album)\\//.test(url)) {
              alert('请输入有效的 NeoDB 链接');
              return;
            }
            insertNeoDBLink(url);
          });
          grp.appendChild(btn);
          toolbarEl.appendChild(grp);
        })();

        async function insertNeoDBLink(url) {
          var range = quill.getSelection(true);
          var loadingText = '加载中...';
          quill.insertText(range.index, loadingText, { color: '#999' });
          try {
            var res = await fetch('/api/neodb?url=' + encodeURIComponent(url));
            var data = await res.json();
            quill.deleteText(range.index, loadingText.length);
            if (data.title) {
              quill.insertEmbed(range.index, 'neodb-card', data, Quill.sources.USER);
              quill.setSelection(range.index + 1);
            } else {
              quill.insertText(range.index, url, { link: url });
            }
          } catch (err) {
            quill.deleteText(range.index, loadingText.length);
            quill.insertText(range.index, url, { link: url });
          }
        }

        // 粘贴处理（NeoDB 链接 + 图片）- capture 阶段拦截，在 Quill 之前处理
        document.querySelector('#editor').addEventListener('paste', async function(e) {
          // 检查 NeoDB 链接
          var text = e.clipboardData?.getData('text/plain') || '';
          if (text && /neodb\\.social\\/(movie|book|tv|music|game|podcast|album)\\//.test(text.trim())) {
            e.preventDefault();
            e.stopPropagation();
            insertNeoDBLink(text.trim());
            return;
          }
          // 检查粘贴图片
          var items = e.clipboardData?.items;
          if (!items) return;
          for (var i = 0; i < items.length; i++) {
            if (items[i].type.startsWith('image/')) {
              e.preventDefault();
              e.stopPropagation();
              var file = items[i].getAsFile();
              if (file) await uploadImage(file);
              break;
            }
          }
        }, true);

        async function uploadImage(file) {
          var formData = new FormData();
          formData.append('image', file);
          try {
            var res = await fetch('/api/upload', { method: 'POST', body: formData });
            var data = await res.json();
            if (data.url) {
              var range = quill.getSelection(true);
              quill.insertEmbed(range.index, 'image', data.url);
              quill.setSelection(range.index + 1);
            }
          } catch (err) {
            console.error('Upload failed:', err);
            alert('图片上传失败');
          }
        }

        // 表单提交前将内容写入隐藏字段（卡片 HTML 已在编辑器中）
        document.getElementById('topic-form').addEventListener('submit', function(e) {
          var content = quill.root.innerHTML;
          document.getElementById('content').value = content === '<p><br></p>' ? '' : content;
        });
      ` }} />
    </Layout>
  )
})

// 发布话题处理
group.post('/:id/topic/new', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const groupId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  // 检查是否是成员
  const membership = await db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id)))
    .limit(1)

  if (membership.length === 0) {
    return c.redirect(`/group/${groupId}`)
  }

  const body = await c.req.parseBody()
  const title = body.title as string
  const content = body.content as string
  const syncMastodon = body.syncMastodon as string

  if (!title || !title.trim()) {
    return c.redirect(`/group/${groupId}/topic/new`)
  }

  const topicId = generateId()
  const topicNow = new Date()

  await db.insert(topics).values({
    id: topicId,
    groupId,
    userId: user.id,
    title: title.trim(),
    content: content?.trim() || null,
    type: 0,
    createdAt: topicNow,
    updatedAt: topicNow,
  })

  // 同步发布到 Mastodon
  if (syncMastodon === '1') {
    try {
      const authProvider = await db.query.authProviders.findFirst({
        where: and(
          eq(authProviders.userId, user.id),
          eq(authProviders.providerType, 'mastodon')
        ),
      })

      if (authProvider?.accessToken) {
        const domain = authProvider.providerId.split('@')[1]
        const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
        const tootContent = `${title.trim()}\n\n${baseUrl}/topic/${topicId}`
        const toot = await postStatus(domain, authProvider.accessToken, tootContent)
        // Save Mastodon status ID for reply sync
        await db.update(topics)
          .set({ mastodonStatusId: toot.id, mastodonDomain: domain })
          .where(eq(topics.id, topicId))
      }
    } catch (e) {
      console.error('Failed to sync toot:', e)
    }
  }

  // AP: deliver Create(Note) to followers
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  c.executionCtx.waitUntil(
    deliverTopicToFollowers(db, baseUrl, user.id, topicId, title.trim(), content?.trim() || null)
  )

  return c.redirect(`/topic/${topicId}`)
})

// 小组设置页面
group.get('/:id/settings', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const groupId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  // 获取小组信息
  const groupResult = await db
    .select()
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1)

  if (groupResult.length === 0) {
    return c.notFound()
  }

  const groupData = groupResult[0]

  // 检查是否是创建者
  if (groupData.creatorId !== user.id) {
    return c.redirect(`/group/${groupId}`)
  }

  return c.html(
    <Layout user={user} title={`小组设置 - ${groupData.name}`} unreadCount={c.get('unreadNotificationCount')}>
      <div class="new-topic-page">
        <div class="page-header">
          <h1>小组设置</h1>
          <p class="page-subtitle">管理 <a href={`/group/${groupId}`}>{groupData.name}</a></p>
        </div>

        <form action={`/group/${groupId}/settings`} method="POST" enctype="multipart/form-data" class="topic-form">
          <div class="form-group">
            <label>当前 LOGO</label>
            <div style="margin-bottom: 10px;">
              <img src={resizeImage(groupData.iconUrl, 160) || '/static/img/default-group.svg'} alt="" class="group-icon" style="width: 80px; height: 80px;" />
            </div>
            <label for="icon">更换 LOGO</label>
            <input type="file" id="icon" name="icon" accept="image/*" />
            <p style="color: #999; font-size: 12px; margin-top: 5px;">支持 JPG、PNG、GIF、WebP 格式</p>
          </div>

          <div class="form-group">
            <label for="description">小组简介</label>
            <textarea id="description" name="description" rows={5} placeholder="介绍一下这个小组...">{groupData.description || ''}</textarea>
          </div>

          <div class="form-group">
            <label for="tags">分类标签 <span style="color: #999; font-weight: normal;">(空格分隔)</span></label>
            <input type="text" id="tags" name="tags" value={groupData.tags || ''} placeholder="输入标签，空格分隔，如：电影 读书 音乐" />
          </div>

          <div class="form-actions">
            <button type="submit" class="btn btn-primary">保存设置</button>
            <a href={`/group/${groupId}`} class="btn">取消</a>
          </div>
        </form>
      </div>
    </Layout>
  )
})

// 处理小组设置
group.post('/:id/settings', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const groupId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  // 获取小组信息
  const groupResult = await db
    .select()
    .from(groups)
    .where(eq(groups.id, groupId))
    .limit(1)

  if (groupResult.length === 0) {
    return c.notFound()
  }

  const groupData = groupResult[0]

  // 检查是否是创建者
  if (groupData.creatorId !== user.id) {
    return c.redirect(`/group/${groupId}`)
  }

  const body = await c.req.parseBody()
  const description = body.description as string
  const tags = body.tags as string
  const iconFile = body.icon as File | undefined

  let iconUrl = groupData.iconUrl

  // 处理头像上传
  if (iconFile && iconFile.size > 0 && c.env.R2) {
    try {
      const buffer = await iconFile.arrayBuffer()
      const ext = getExtFromFile(iconFile.name, iconFile.type)
      const contentType = getContentType(ext)
      const key = `groups/${groupId}.${ext}`

      await c.env.R2.put(key, buffer, {
        httpMetadata: { contentType },
      })

      const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
      iconUrl = `${baseUrl}/r2/${key}`
    } catch (error) {
      console.error('Failed to upload group icon:', error)
    }
  }

  // 更新小组信息
  await db.update(groups)
    .set({
      description: description?.trim() || null,
      tags: tags?.trim() || null,
      iconUrl,
      updatedAt: now(),
    })
    .where(eq(groups.id, groupId))

  return c.redirect(`/group/${groupId}`)
})

// 从文件名或 MIME 类型获取扩展名
function getExtFromFile(filename: string, mimeType: string): string {
  // 先尝试从文件名获取
  const match = filename.match(/\.(\w+)$/)
  if (match) {
    const ext = match[1].toLowerCase()
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
      return ext === 'jpg' ? 'jpeg' : ext
    }
  }
  // 从 MIME 类型获取
  const mimeMap: Record<string, string> = {
    'image/jpeg': 'jpeg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
  }
  return mimeMap[mimeType] || 'png'
}

export default group
