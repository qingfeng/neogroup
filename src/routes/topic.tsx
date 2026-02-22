import { Hono } from 'hono'
import { eq, desc, and, sql, ne } from 'drizzle-orm'
import type { AppContext } from '../types'
import { topics, users, groups, comments, commentLikes, commentReposts, topicLikes, topicReposts, groupMembers, authProviders, remoteGroups, apFollowers, groupTokens, tokenBalances, tokenTxs, remoteTokens } from '../db/schema'
import { Layout } from '../components/Layout'
import { generateId, stripHtml, truncate, parseJson, resizeImage, processContentImages, isSuperAdmin, isNostrEnabled } from '../lib/utils'
import { SafeHtml } from '../components/SafeHtml'
import { createNotification } from '../lib/notifications'
import { syncMastodonReplies, syncCommentReplies } from '../services/mastodon-sync'
import { postStatus, resolveStatusId, reblogStatus, resolveStatusByUrl, unreblogStatus, deleteStatus } from '../services/mastodon'
import { deliverCommentToFollowers, announceToUserFollowers, ensureKeyPair, signAndDeliver, fetchActor, getApUsername } from '../services/activitypub'
import { buildSignedEvent } from '../services/nostr'

const topic = new Hono<AppContext>()

topic.get('/:id', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')

  // 获取话题详情
  const topicResult = await db
    .select({
      id: topics.id,
      groupId: topics.groupId,
      userId: topics.userId,
      title: topics.title,
      content: topics.content,
      type: topics.type,
      images: topics.images,
      mastodonStatusId: topics.mastodonStatusId,
      mastodonDomain: topics.mastodonDomain,
      createdAt: topics.createdAt,
      updatedAt: topics.updatedAt,
      user: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      },
      group: {
        id: groups.id,
        name: groups.name,
        description: groups.description,
        actorName: groups.actorName,
        iconUrl: groups.iconUrl,
      },
    })
    .from(topics)
    .innerJoin(users, eq(topics.userId, users.id))
    .leftJoin(groups, eq(topics.groupId, groups.id))
    .where(eq(topics.id, topicId))
    .limit(1)

  if (topicResult.length === 0) {
    return c.notFound()
  }

  const topicData = topicResult[0]
  const groupId = topicData.groupId

  // Group-related data (may be null for personal posts)
  let memberCount = 0
  let isMember = false
  let latestTopics: any[] = []

  if (groupId) {
    // 获取小组成员数
    const memberCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId))
    memberCount = memberCountResult[0]?.count || 0

    // 检查当前用户是否是成员
    if (user) {
      const membership = await db
        .select()
        .from(groupMembers)
        .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id)))
        .limit(1)
      isMember = membership.length > 0
    }

    // 获取小组最新话题（排除当前话题）
    latestTopics = await db
      .select({
        id: topics.id,
        title: topics.title,
        user: {
          id: users.id,
          username: users.username,
          displayName: users.displayName,
        },
      })
      .from(topics)
      .innerJoin(users, eq(topics.userId, users.id))
      .where(and(eq(topics.groupId, groupId), ne(topics.id, topicId)))
      .orderBy(desc(topics.updatedAt))
      .limit(5)
  }

  // Sync Mastodon replies if applicable
  if (topicData.mastodonStatusId && topicData.mastodonDomain) {
    try {
      await syncMastodonReplies(db, topicId, topicData.mastodonDomain, topicData.mastodonStatusId)
    } catch (e) {
      console.error('Failed to sync Mastodon replies:', e)
    }
  }

  // Sync replies to comments posted as independent Mastodon status
  const commentsWithMastodon = await db
    .select({ id: comments.id, mastodonStatusId: comments.mastodonStatusId, mastodonDomain: comments.mastodonDomain })
    .from(comments)
    .where(eq(comments.topicId, topicId))

  for (const comment of commentsWithMastodon) {
    if (comment.mastodonStatusId && comment.mastodonDomain) {
      try {
        await syncCommentReplies(db, topicId, comment.id, comment.mastodonDomain, comment.mastodonStatusId)
      } catch (e) {
        console.error('Failed to sync comment replies:', e)
      }
    }
  }

  // 获取话题喜欢数
  const topicLikeCountResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(topicLikes)
    .where(eq(topicLikes.topicId, topicId))
  const topicLikeCount = topicLikeCountResult[0]?.count || 0

  // 检查当前用户是否喜欢
  let isTopicLiked = false
  if (user) {
    const existingLike = await db
      .select()
      .from(topicLikes)
      .where(and(eq(topicLikes.topicId, topicId), eq(topicLikes.userId, user.id)))
      .limit(1)
    isTopicLiked = existingLike.length > 0
  }

  // 获取转发数
  const repostCountResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(topicReposts)
    .where(eq(topicReposts.topicId, topicId))
  const repostCount = repostCountResult[0]?.count || 0

  // 获取转发者列表
  const reposters = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    })
    .from(topicReposts)
    .innerJoin(users, eq(topicReposts.userId, users.id))
    .where(eq(topicReposts.topicId, topicId))
    .orderBy(desc(topicReposts.createdAt))

  // 检查当前用户是否已转发
  let isReposted = false
  if (user) {
    const existingRepost = await db
      .select()
      .from(topicReposts)
      .where(and(eq(topicReposts.topicId, topicId), eq(topicReposts.userId, user.id)))
      .limit(1)
    isReposted = existingRepost.length > 0
  }

  // 检查用户是否有 Mastodon 账号（用于评论同步）
  let hasMastodonAuth = false
  if (user) {
    const ap = await db.query.authProviders.findFirst({
      where: and(eq(authProviders.userId, user.id), eq(authProviders.providerType, 'mastodon')),
    })
    hasMastodonAuth = !!(ap?.accessToken)
  }
  const canRepost = hasMastodonAuth

  // ── Token Tip 数据 ──
  // 用户持有的 Token（供打赏弹窗选择）
  type UserTokenInfo = { tokenId: string; tokenType: string; balance: number; symbol: string; name: string; iconUrl: string }
  let userTokens: UserTokenInfo[] = []
  if (user) {
    const balances = await db.select({
      tokenId: tokenBalances.tokenId,
      tokenType: tokenBalances.tokenType,
      balance: tokenBalances.balance,
    }).from(tokenBalances).where(eq(tokenBalances.userId, user.id))
    for (const b of balances) {
      if (b.balance <= 0) continue
      if (b.tokenType === 'local') {
        const t = await db.select({ symbol: groupTokens.symbol, name: groupTokens.name, iconUrl: groupTokens.iconUrl })
          .from(groupTokens).where(eq(groupTokens.id, b.tokenId)).limit(1)
        if (t.length > 0) userTokens.push({ tokenId: b.tokenId, tokenType: b.tokenType, balance: b.balance, symbol: t[0].symbol, name: t[0].name, iconUrl: t[0].iconUrl })
      } else {
        const t = await db.select({ symbol: remoteTokens.symbol, name: remoteTokens.name, iconUrl: remoteTokens.iconUrl })
          .from(remoteTokens).where(eq(remoteTokens.id, b.tokenId)).limit(1)
        if (t.length > 0) userTokens.push({ tokenId: b.tokenId, tokenType: b.tokenType, balance: b.balance, symbol: t[0].symbol, name: t[0].name, iconUrl: t[0].iconUrl || '' })
      }
    }
  }

  // 话题收到的打赏汇总
  type TipSummary = { tokenId: string; symbol: string; iconUrl: string; total: number }
  const topicTipRows = await db.all<{ token_id: string; token_type: string; total: number }>(
    sql`SELECT token_id, token_type, SUM(amount) as total FROM token_tx
        WHERE ref_id = ${topicId} AND ref_type = 'topic' AND type = 'tip'
        GROUP BY token_id, token_type`
  )
  const topicTipSummary: TipSummary[] = []
  for (const row of topicTipRows) {
    if (row.token_type === 'local') {
      const t = await db.select({ symbol: groupTokens.symbol, iconUrl: groupTokens.iconUrl })
        .from(groupTokens).where(eq(groupTokens.id, row.token_id)).limit(1)
      if (t.length > 0) topicTipSummary.push({ tokenId: row.token_id, symbol: t[0].symbol, iconUrl: t[0].iconUrl, total: row.total })
    } else {
      const t = await db.select({ symbol: remoteTokens.symbol, iconUrl: remoteTokens.iconUrl })
        .from(remoteTokens).where(eq(remoteTokens.id, row.token_id)).limit(1)
      if (t.length > 0) topicTipSummary.push({ tokenId: row.token_id, symbol: t[0].symbol, iconUrl: t[0].iconUrl || '', total: row.total })
    }
  }

  // 分页参数
  const PAGE_SIZE = 50
  const page = Math.max(1, parseInt(c.req.query('page') || '1') || 1)
  const authorOnly = c.req.query('author_only') === '1'

  // 评论查询条件
  const commentCondition = authorOnly
    ? and(eq(comments.topicId, topicId), eq(comments.userId, topicData.userId))
    : eq(comments.topicId, topicId)

  // 获取评论总数
  const totalResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(comments)
    .where(commentCondition)
  const totalComments = totalResult[0]?.count || 0
  const totalPages = Math.ceil(totalComments / PAGE_SIZE)

  // 获取评论列表（包含点赞数）
  const commentList = await db
    .select({
      id: comments.id,
      content: comments.content,
      replyToId: comments.replyToId,
      createdAt: comments.createdAt,
      user: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      },
      likeCount: sql<number>`(SELECT COUNT(*) FROM comment_like WHERE comment_like.comment_id = ${comments.id})`.as('like_count'),
      repostCount: sql<number>`(SELECT COUNT(*) FROM comment_repost WHERE comment_repost.comment_id = ${comments.id})`.as('repost_count'),
      mastodonStatusId: comments.mastodonStatusId,
      mastodonDomain: comments.mastodonDomain,
    })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .where(commentCondition)
    .orderBy(comments.createdAt)
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE)

  // 获取当前用户点赞的评论ID列表
  let userLikedCommentIds: Set<string> = new Set()
  if (user) {
    const userLikes = await db
      .select({ commentId: commentLikes.commentId })
      .from(commentLikes)
      .where(eq(commentLikes.userId, user.id))
    userLikedCommentIds = new Set(userLikes.map(l => l.commentId))
  }

  // 获取当前用户转发的评论ID列表
  let userRepostedCommentIds: Set<string> = new Set()
  if (user) {
    const userReposts = await db
      .select({ commentId: commentReposts.commentId })
      .from(commentReposts)
      .where(eq(commentReposts.userId, user.id))
    userRepostedCommentIds = new Set(userReposts.map(r => r.commentId))
  }

  // 构建评论ID到评论的映射（用于引用回复显示）
  const commentMap = new Map(commentList.map(c => [c.id, c]))

  // 评论收到的打赏汇总（按评论 ID 分组）
  const commentTipMap = new Map<string, TipSummary[]>()
  if (commentList.length > 0) {
    const commentIds = commentList.map(c => c.id)
    const commentTipRows = await db.all<{ ref_id: string; token_id: string; token_type: string; total: number }>(
      sql`SELECT ref_id, token_id, token_type, SUM(amount) as total FROM token_tx
          WHERE ref_id IN (${sql.join(commentIds.map(id => sql`${id}`), sql`, `)}) AND ref_type = 'comment' AND type = 'tip'
          GROUP BY ref_id, token_id, token_type`
    )
    for (const row of commentTipRows) {
      let symbol = ''; let iconUrl = ''
      if (row.token_type === 'local') {
        const t = await db.select({ symbol: groupTokens.symbol, iconUrl: groupTokens.iconUrl })
          .from(groupTokens).where(eq(groupTokens.id, row.token_id)).limit(1)
        if (t.length > 0) { symbol = t[0].symbol; iconUrl = t[0].iconUrl }
      } else {
        const t = await db.select({ symbol: remoteTokens.symbol, iconUrl: remoteTokens.iconUrl })
          .from(remoteTokens).where(eq(remoteTokens.id, row.token_id)).limit(1)
        if (t.length > 0) { symbol = t[0].symbol; iconUrl = t[0].iconUrl || '' }
      }
      if (!symbol) continue
      const existing = commentTipMap.get(row.ref_id) || []
      existing.push({ tokenId: row.token_id, symbol, iconUrl, total: row.total })
      commentTipMap.set(row.ref_id, existing)
    }
  }

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  // 生成 metadata
  const description = topicData.content
    ? truncate(stripHtml(topicData.content), 160)
    : undefined

  const images = parseJson<string[]>(topicData.images, [])
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  // 优先使用帖子图片，否则使用小组图标
  const ogImage = images.length > 0
    ? images[0]
    : (topicData.group?.iconUrl || `${baseUrl}/static/img/default-group.svg`)

  const topicUrl = `${baseUrl}/topic/${topicId}`

  // JSON-LD 结构化数据
  const jsonLd: Record<string, any> = {
    '@context': 'https://schema.org',
    '@type': 'DiscussionForumPosting',
    headline: topicData.title || description || 'Post',
    url: topicUrl,
    datePublished: topicData.createdAt.toISOString(),
    dateModified: topicData.updatedAt.toISOString(),
    author: {
      '@type': 'Person',
      name: topicData.user.displayName || topicData.user.username,
      url: `${baseUrl}/user/${topicData.user.username}`,
    },
    interactionStatistic: {
      '@type': 'InteractionCounter',
      interactionType: 'https://schema.org/CommentAction',
      userInteractionCount: commentList.length,
    },
    ...(description ? { description } : {}),
    ...(ogImage ? { image: ogImage } : {}),
  }
  if (topicData.group) {
    jsonLd.isPartOf = {
      '@type': 'WebPage',
      name: topicData.group.name,
      url: `${baseUrl}/group/${topicData.group.id}`,
    }
  }

  // Fediverse creator attribution — always use local AP identity
  // so attributionDomains on our Actor matches
  const siteDomain = new URL(baseUrl).host
  const fediverseCreator = `@${topicData.user.username}@${siteDomain}`

  return c.html(
    <Layout
      user={user}
      title={topicData.title}
      description={description}
      image={ogImage}
      url={topicUrl}
      ogType="article"
      jsonLd={jsonLd}
      unreadCount={c.get('unreadNotificationCount')}
      siteName={c.env.APP_NAME}
      fediverseCreator={fediverseCreator}
    >
      <div class="topic-page-layout">
        <div class="topic-detail">
          {topicData.group && (
            <div class="topic-header">
              <a href={`/group/${topicData.group.actorName || topicData.group.id}`} class="topic-group">
                <img src={resizeImage(topicData.group.iconUrl, 40) || '/static/img/default-group.svg'} alt="" class="group-icon-sm" />
                <span>{topicData.group.name}</span>
              </a>
            </div>
          )}

          {topicData.title && <h1 class="topic-title">{topicData.title}</h1>}

          <div class="topic-meta">
            <a href={`/user/${topicData.user.username}`} class="topic-author">
              <img
                src={resizeImage(topicData.user.avatarUrl, 64) || '/static/img/default-avatar.svg'}
                alt=""
                class="avatar-sm"
              />
              <span>{topicData.user.displayName || topicData.user.username}</span>
            </a>
            <span class="topic-date">{formatDate(topicData.createdAt)}</span>
            {user && (user.id === topicData.userId || isSuperAdmin(user)) && (
              <span class="topic-actions-inline">
                {user.id === topicData.userId && (
                  <a href={`/topic/${topicId}/edit`} class="topic-edit-link">编辑</a>
                )}
                {isSuperAdmin(user) ? (
                  <form action={`/topic/${topicId}/delete`} method="POST" style="display: inline;" onsubmit={`return confirm('确定要删除这个话题吗？${commentList.length > 0 ? '将同时删除 ' + commentList.length + ' 条评论。' : ''}删除后无法恢复。')`}>
                    <button type="submit" class="topic-edit-link" style="border: none; background: none; cursor: pointer; color: #c00; padding: 0;">删除</button>
                  </form>
                ) : commentList.length > 0 ? (
                  <button type="button" class="topic-edit-link" style="border: none; background: none; cursor: pointer; color: #c00; padding: 0;" onclick="alert('该话题下还有评论，请先删除全部评论后再删除话题。')">删除</button>
                ) : (
                  <form action={`/topic/${topicId}/delete`} method="POST" style="display: inline;" onsubmit="return confirm('确定要删除这个话题吗？删除后无法恢复。')">
                    <button type="submit" class="topic-edit-link" style="border: none; background: none; cursor: pointer; color: #c00; padding: 0;">删除</button>
                  </form>
                )}
              </span>
            )}
          </div>

          {topicData.content && (
            <SafeHtml html={processContentImages(topicData.content)} className="topic-content" />
          )}

          <div class="topic-like-section">
            {user ? (
              <form action={`/topic/${topicId}/like`} method="POST" style="display: inline;">
                <button type="submit" class={`topic-like-btn ${isTopicLiked ? 'liked' : ''}`}>
                  {isTopicLiked ? '已喜欢' : '喜欢'}
                  {topicLikeCount > 0 ? ` (${topicLikeCount})` : ''}
                </button>
              </form>
            ) : (
              <span class="topic-like-btn disabled">
                喜欢{topicLikeCount > 0 ? ` (${topicLikeCount})` : ''}
              </span>
            )}
            {canRepost && !isReposted && (
              <form action={`/topic/${topicId}/repost`} method="POST" style="display: inline;">
                <button type="submit" class={`topic-like-btn`} onclick="this.disabled=true;this.form.submit();">
                  转发{repostCount > 0 ? ` (${repostCount})` : ''}
                </button>
              </form>
            )}
            {canRepost && isReposted && (
              <form action={`/topic/${topicId}/unrepost`} method="POST" style="display: inline;">
                <button type="submit" class="topic-like-btn reposted" onclick="this.disabled=true;this.form.submit();">
                  已转发（撤销）{repostCount > 0 ? ` (${repostCount})` : ''}
                </button>
              </form>
            )}
            {!canRepost && repostCount > 0 && (
              <span class="topic-like-btn disabled">
                转发 ({repostCount})
              </span>
            )}
            {repostCount > 0 && (
              <button type="button" class="repost-count-link" onclick="document.getElementById('reposters-modal').style.display='flex'">
                {repostCount} 人转发
              </button>
            )}
            {c.env.LNBITS_URL && (
            <button type="button" class="topic-like-btn zap-btn" onclick="document.getElementById('zap-modal').style.display='flex'">
              Zap
            </button>
            )}
            {user && userTokens.length > 0 && user.id !== topicData.userId && (
              <button type="button" class="topic-like-btn tip-btn" onclick="document.getElementById('topic-tip-modal').style.display='flex'">
                打赏
              </button>
            )}
            {topicTipSummary.length > 0 && (
              <span class="tip-summary">
                {topicTipSummary.map((tip) => (
                  <span class="tip-badge" key={tip.tokenId}>
                    {tip.iconUrl.startsWith('http') ? (
                      <img src={tip.iconUrl} alt="" style="width:14px;height:14px;vertical-align:middle;margin-right:2px" />
                    ) : (
                      <span style="margin-right:2px">{tip.iconUrl}</span>
                    )}
                    {tip.total} {tip.symbol}
                  </span>
                ))}
              </span>
            )}
          </div>

          {repostCount > 0 && (
            <div id="reposters-modal" class="modal-overlay" style="display:none" onclick="if(event.target===this)this.style.display='none'">
              <div class="modal-content">
                <div class="modal-header">
                  <span class="modal-title">转发者</span>
                  <button type="button" class="modal-close" onclick="document.getElementById('reposters-modal').style.display='none'">&times;</button>
                </div>
                <div class="modal-body">
                  {reposters.map((r) => (
                    <a href={`/user/${r.username}`} class="reposter-item" key={r.id}>
                      <img src={resizeImage(r.avatarUrl, 64) || '/static/img/default-avatar.svg'} alt="" class="avatar-sm" />
                      <span>{r.displayName || r.username}</span>
                    </a>
                  ))}
                </div>
              </div>
            </div>
          )}

          {c.env.LNBITS_URL && (<>
          {/* Zap Modal */}
          <div id="zap-modal" class="modal-overlay" style="display:none" onclick="if(event.target===this)this.style.display='none'">
            <div class="modal-content">
              <div class="modal-header">
                <span class="modal-title">Zap {topicData.user.displayName || topicData.user.username}</span>
                <button type="button" class="modal-close" onclick="document.getElementById('zap-modal').style.display='none'">&times;</button>
              </div>
              <div class="zap-modal-body">
                <div class="zap-amounts">
                  <button type="button" class="zap-amt-btn selected" data-amt="21" onclick="selectZapAmt(this,21)">21</button>
                  <button type="button" class="zap-amt-btn" data-amt="100" onclick="selectZapAmt(this,100)">100</button>
                  <button type="button" class="zap-amt-btn" data-amt="500" onclick="selectZapAmt(this,500)">500</button>
                  <button type="button" class="zap-amt-btn" data-amt="1000" onclick="selectZapAmt(this,1000)">1k</button>
                  <input type="number" class="zap-custom-input" id="zap-custom" placeholder="自定义" min="1" onfocus="document.querySelectorAll('.zap-amt-btn').forEach(b=>b.classList.remove('selected'))" />
                </div>
                <button type="button" class="zap-send-btn" id="zap-send-btn" onclick={`sendZap('${topicData.user.username}')`}>
                  发送 Zap
                </button>
                <div id="zap-result" class="zap-invoice-area" style="display:none"></div>
                <div id="zap-status" class="zap-status"></div>
              </div>
            </div>
          </div>
          <script dangerouslySetInnerHTML={{ __html: `
            var zapAmount = 21;
            function selectZapAmt(btn, amt) {
              zapAmount = amt;
              document.getElementById('zap-custom').value = '';
              document.querySelectorAll('.zap-amt-btn').forEach(function(b) { b.classList.remove('selected'); });
              btn.classList.add('selected');
            }
            async function sendZap(username) {
              var custom = parseInt(document.getElementById('zap-custom').value);
              var amt = custom > 0 ? custom : zapAmount;
              var msats = amt * 1000;
              var btn = document.getElementById('zap-send-btn');
              var result = document.getElementById('zap-result');
              var status = document.getElementById('zap-status');
              btn.disabled = true;
              btn.textContent = '生成发票中...';
              status.textContent = '';
              result.style.display = 'none';
              try {
                var res = await fetch('/.well-known/lnurlp/' + username + '/callback?amount=' + msats);
                var data = await res.json();
                if (data.pr) {
                  result.innerHTML = '<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(data.pr) + '" alt="QR" />' +
                    '<code onclick="navigator.clipboard.writeText(this.textContent);this.style.borderColor=\\'#3ba726\\';setTimeout(function(){this.style.borderColor=\\'\\'},800)" title="点击复制">' + data.pr + '</code>';
                  result.style.display = 'block';
                  status.textContent = '请使用 Lightning 钱包扫码或复制发票支付';
                  btn.textContent = '发送 Zap';
                  btn.disabled = false;
                } else {
                  throw new Error(data.reason || '获取发票失败');
                }
              } catch (e) {
                status.textContent = e.message || '发送失败';
                btn.textContent = '发送 Zap';
                btn.disabled = false;
              }
            }
          `}} />
          </>)}

          {user && userTokens.length > 0 && user.id !== topicData.userId && (
          <>
          {/* Topic Tip Modal */}
          <div id="topic-tip-modal" class="modal-overlay" style="display:none" onclick="if(event.target===this)this.style.display='none'">
            <div class="modal-content">
              <div class="modal-header">
                <span class="modal-title">打赏 {topicData.user.displayName || topicData.user.username}</span>
                <button type="button" class="modal-close" onclick="document.getElementById('topic-tip-modal').style.display='none'">&times;</button>
              </div>
              <div class="zap-modal-body">
                <div class="form-group" style="margin-bottom:12px">
                  <label style="font-size:13px;color:#666;margin-bottom:4px;display:block">选择 Token</label>
                  <select id="topic-tip-token" class="form-control" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px">
                    {userTokens.map((t) => (
                      <option value={`${t.tokenId}|${t.tokenType}`} key={t.tokenId}>
                        {t.iconUrl && !t.iconUrl.startsWith('http') ? t.iconUrl + ' ' : ''}{t.symbol} (余额: {t.balance.toLocaleString()})
                      </option>
                    ))}
                  </select>
                </div>
                <div class="form-group" style="margin-bottom:12px">
                  <label style="font-size:13px;color:#666;margin-bottom:4px;display:block">数量</label>
                  <input type="number" id="topic-tip-amount" class="form-control" min="1" placeholder="输入打赏数量" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px" />
                </div>
                <button type="button" class="zap-send-btn" id="topic-tip-send" onclick={`sendTokenTip('topic', '${topicId}')`}>
                  发送打赏
                </button>
                <div id="topic-tip-status" class="zap-status"></div>
              </div>
            </div>
          </div>
          </>
          )}

          <script dangerouslySetInnerHTML={{ __html: `
            async function sendTokenTip(type, id, commentId) {
              var prefix = type === 'comment' ? 'comment-tip-' + commentId : 'topic-tip';
              var tokenSelect = document.getElementById(prefix + '-token');
              var amountInput = document.getElementById(prefix + '-amount');
              var sendBtn = document.getElementById(prefix + '-send');
              var statusEl = document.getElementById(prefix + '-status');
              if (!tokenSelect || !amountInput) return;
              var parts = tokenSelect.value.split('|');
              var tokenId = parts[0], tokenType = parts[1];
              var amount = parseInt(amountInput.value);
              if (!amount || amount <= 0) { statusEl.textContent = '请输入有效数量'; return; }
              sendBtn.disabled = true;
              sendBtn.textContent = '发送中...';
              statusEl.textContent = '';
              try {
                var url = type === 'comment'
                  ? '/api/topics/' + id + '/comments/' + commentId + '/tip'
                  : '/api/topics/' + id + '/tip';
                var res = await fetch(url, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ token_id: tokenId, token_type: tokenType, amount: amount }),
                });
                var data = await res.json();
                if (data.ok) {
                  statusEl.style.color = '#3ba726';
                  statusEl.textContent = '打赏成功！';
                  setTimeout(function() { location.reload(); }, 1000);
                } else {
                  throw new Error(data.error || '打赏失败');
                }
              } catch (e) {
                statusEl.style.color = '#c00';
                statusEl.textContent = e.message || '打赏失败';
                sendBtn.textContent = '发送打赏';
                sendBtn.disabled = false;
              }
            }
          `}} />

          <div class="comments-section">
            <div class="comments-header">
              <h2>评论 ({totalComments})</h2>
              {authorOnly ? (
                <a href={`/topic/${topicId}`} class="btn-text">查看全部</a>
              ) : (
                <a href={`/topic/${topicId}?author_only=1`} class="btn-text">只看楼主</a>
              )}
            </div>

            {user ? (
              <form action={`/topic/${topicId}/comment`} method="POST" class="comment-form" id="comment-form">
                <input type="hidden" name="replyToId" id="replyToId" value="" />
                <div id="reply-hint" class="reply-hint" style="display: none;">
                  <span>回复 <strong id="reply-to-name"></strong>: </span>
                  <span id="reply-to-preview" class="reply-preview"></span>
                  <button type="button" class="cancel-reply" onclick="cancelReply()">取消</button>
                </div>
                <textarea
                  name="content"
                  id="comment-textarea"
                  placeholder="写下你的评论..."
                  rows={3}
                  required
                ></textarea>
                <button type="submit" class="btn btn-primary">发表评论</button>
              </form>
            ) : (
              <p class="login-hint">
                <a href="/auth/login">登录</a> 后发表评论
              </p>
            )}

            <script dangerouslySetInnerHTML={{
              __html: `
            function showReplyForm(commentId, authorName, preview) {
              document.getElementById('replyToId').value = commentId;
              document.getElementById('reply-to-name').textContent = authorName;
              document.getElementById('reply-to-preview').textContent = preview;
              document.getElementById('reply-hint').style.display = 'flex';
              document.getElementById('comment-textarea').focus();
              document.getElementById('comment-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            function cancelReply() {
              document.getElementById('replyToId').value = '';
              document.getElementById('reply-hint').style.display = 'none';
            }
            function showEditForm(commentId) {
              document.getElementById('edit-form-' + commentId).style.display = 'block';
            }
            function hideEditForm(commentId) {
              document.getElementById('edit-form-' + commentId).style.display = 'none';
            }
          ` }} />

            <div class="comment-list">
              {commentList.length === 0 ? (
                <p class="no-comments">暂无评论</p>
              ) : (
                commentList.map((comment, index) => {
                  const isAuthor = comment.user.id === topicData.userId
                  const isLiked = userLikedCommentIds.has(comment.id)
                  const isCommentReposted = userRepostedCommentIds.has(comment.id)
                  const replyTo = comment.replyToId ? commentMap.get(comment.replyToId) : null
                  return (
                    <div class="comment-item" key={comment.id} id={`comment-${comment.id}`}>
                      <div class="comment-avatar">
                        <a href={`/user/${comment.user.username}`}>
                          <img
                            src={resizeImage(comment.user.avatarUrl, 96) || '/static/img/default-avatar.svg'}
                            alt=""
                            class="avatar"
                          />
                        </a>
                      </div>
                      <div class="comment-body">
                        <div class="comment-header">
                          <a href={`/user/${comment.user.username}`} class="comment-author-name">
                            {comment.user.displayName || comment.user.username}
                          </a>
                          {isAuthor && <span class="author-badge">楼主</span>}
                          <span class="comment-date">{formatDate(comment.createdAt)}</span>
                        </div>
                        {replyTo && (
                          <div class="comment-quote">
                            <span class="quote-content" dangerouslySetInnerHTML={{ __html: truncate(stripHtml(replyTo.content), 50) }} />
                            <a href={`/user/${replyTo.user.username}`} class="quote-author">
                              {replyTo.user.displayName || replyTo.user.username}
                            </a>
                          </div>
                        )}
                        <SafeHtml html={comment.content} className="comment-content" />
                        <div class="comment-actions">
                          {user ? (
                            <form action={`/topic/${topicId}/comment/${comment.id}/like`} method="POST" style="display: inline;">
                              <button type="submit" class={`comment-action-btn ${isLiked ? 'liked' : ''}`}>
                                赞{comment.likeCount > 0 ? ` (${comment.likeCount})` : ''}
                              </button>
                            </form>
                          ) : (
                            <span class="comment-action-btn disabled">
                              赞{comment.likeCount > 0 ? ` (${comment.likeCount})` : ''}
                            </span>
                          )}
                          {user && (
                            <button
                              type="button"
                              class="comment-action-btn"
                              onclick={`showReplyForm('${comment.id}', '${(comment.user.displayName || comment.user.username).replace(/'/g, "\\'")}', '${truncate(stripHtml(comment.content), 30).replace(/'/g, "\\'")}')`}
                            >
                              回复
                            </button>
                          )}
                          {canRepost && !isCommentReposted && (
                            <form action={`/topic/${topicId}/comment/${comment.id}/repost`} method="POST" style="display: inline;">
                              <button type="submit" class="comment-action-btn" onclick="this.disabled=true;this.form.submit();">
                                转发{comment.repostCount > 0 ? ` (${comment.repostCount})` : ''}
                              </button>
                            </form>
                          )}
                          {canRepost && isCommentReposted && (
                            <form action={`/topic/${topicId}/comment/${comment.id}/unrepost`} method="POST" style="display: inline;">
                              <button type="submit" class="comment-action-btn reposted" onclick="this.disabled=true;this.form.submit();">
                                已转发（撤销）{comment.repostCount > 0 ? ` (${comment.repostCount})` : ''}
                              </button>
                            </form>
                          )}
                          {user && user.id === comment.user.id && (
                            <button
                              type="button"
                              class="comment-action-btn"
                              onclick={`showEditForm('${comment.id}')`}
                            >
                              编辑
                            </button>
                          )}
                          {user && (user.id === comment.user.id || isSuperAdmin(user)) && (
                            <form action={`/topic/${topicId}/comment/${comment.id}/delete`} method="POST" style="display: inline;" onsubmit="return confirm('确定要删除这条评论吗？')">
                              <button type="submit" class="comment-action-btn" style="color: #c00;">删除</button>
                            </form>
                          )}
                          {user && userTokens.length > 0 && user.id !== comment.user.id && (
                            <button
                              type="button"
                              class="comment-action-btn tip-btn"
                              onclick={`document.getElementById('comment-tip-modal-${comment.id}').style.display='flex'`}
                            >
                              打赏
                            </button>
                          )}
                          {(() => {
                            const tips = commentTipMap.get(comment.id)
                            if (!tips || tips.length === 0) return null
                            return (
                              <span class="tip-summary" style="margin-left:4px">
                                {tips.map((tip) => (
                                  <span class="tip-badge" key={tip.tokenId}>
                                    {tip.iconUrl.startsWith('http') ? (
                                      <img src={tip.iconUrl} alt="" style="width:12px;height:12px;vertical-align:middle;margin-right:1px" />
                                    ) : (
                                      <span style="margin-right:1px;font-size:12px">{tip.iconUrl}</span>
                                    )}
                                    {tip.total} {tip.symbol}
                                  </span>
                                ))}
                              </span>
                            )
                          })()}
                        </div>
                        {/* Comment Tip Modal */}
                        {user && userTokens.length > 0 && user.id !== comment.user.id && (
                          <div id={`comment-tip-modal-${comment.id}`} class="modal-overlay" style="display:none" onclick={`if(event.target===this)this.style.display='none'`}>
                            <div class="modal-content">
                              <div class="modal-header">
                                <span class="modal-title">打赏 {comment.user.displayName || comment.user.username}</span>
                                <button type="button" class="modal-close" onclick={`document.getElementById('comment-tip-modal-${comment.id}').style.display='none'`}>&times;</button>
                              </div>
                              <div class="zap-modal-body">
                                <div class="form-group" style="margin-bottom:12px">
                                  <label style="font-size:13px;color:#666;margin-bottom:4px;display:block">选择 Token</label>
                                  <select id={`comment-tip-${comment.id}-token`} class="form-control" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px">
                                    {userTokens.map((t) => (
                                      <option value={`${t.tokenId}|${t.tokenType}`} key={t.tokenId}>
                                        {t.iconUrl && !t.iconUrl.startsWith('http') ? t.iconUrl + ' ' : ''}{t.symbol} (余额: {t.balance.toLocaleString()})
                                      </option>
                                    ))}
                                  </select>
                                </div>
                                <div class="form-group" style="margin-bottom:12px">
                                  <label style="font-size:13px;color:#666;margin-bottom:4px;display:block">数量</label>
                                  <input type="number" id={`comment-tip-${comment.id}-amount`} class="form-control" min="1" placeholder="输入打赏数量" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px" />
                                </div>
                                <button type="button" class="zap-send-btn" id={`comment-tip-${comment.id}-send`} onclick={`sendTokenTip('comment', '${topicId}', '${comment.id}')`}>
                                  发送打赏
                                </button>
                                <div id={`comment-tip-${comment.id}-status`} class="zap-status"></div>
                              </div>
                            </div>
                          </div>
                        )}
                        {user && user.id === comment.user.id && (
                          <div class="comment-edit-form" id={`edit-form-${comment.id}`} style="display: none;">
                            <form action={`/topic/${topicId}/comment/${comment.id}/edit`} method="POST">
                              <textarea name="content" rows={3} class="comment-edit-textarea">{stripHtml(comment.content)}</textarea>
                              <div class="comment-edit-actions">
                                <button type="submit" class="btn btn-primary">保存</button>
                                <button type="button" class="btn" onclick={`hideEditForm('${comment.id}')`}>取消</button>
                              </div>
                            </form>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            {totalPages > 1 && (
              <div class="pagination">
                {page > 1 && (
                  <a href={`/topic/${topicId}?page=${page - 1}${authorOnly ? '&author_only=1' : ''}`} class="pagination-link">上一页</a>
                )}
                <span class="pagination-info">第 {page} / {totalPages} 页</span>
                {page < totalPages && (
                  <a href={`/topic/${topicId}?page=${page + 1}${authorOnly ? '&author_only=1' : ''}`} class="pagination-link">下一页</a>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 右侧边栏 */}
        <aside class="topic-sidebar">
          {topicData.group ? (
            <>
              {/* 小组信息卡片 */}
              <div class="sidebar-group-card">
                <div class="sidebar-group-header">
                  <img
                    src={resizeImage(topicData.group.iconUrl, 160) || '/static/img/default-group.svg'}
                    alt=""
                    class="sidebar-group-icon"
                  />
                  <div class="sidebar-group-info">
                    <a href={`/group/${topicData.group.actorName || groupId}`} class="sidebar-group-name">{topicData.group.name}</a>
                    {topicData.group.description && (
                      <p class="sidebar-group-desc">{truncate(topicData.group.description, 50)}</p>
                    )}
                  </div>
                </div>
                <div class="sidebar-group-stats">
                  <strong>{memberCount}</strong> 人聚集在这个小组
                </div>
                {user && !isMember && (
                  <form action={`/group/${groupId}/join`} method="POST">
                    <button type="submit" class="btn btn-primary sidebar-join-btn">加入小组</button>
                  </form>
                )}
                {user && isMember && (
                  <div class="sidebar-member-status">已加入</div>
                )}
              </div>

              {/* 最新讨论 */}
              {latestTopics.length > 0 && (
                <div class="sidebar-latest">
                  <div class="sidebar-latest-header">
                    <span>最新讨论</span>
                    <a href={`/group/${topicData.group.actorName || groupId}`} class="sidebar-more">（更多）</a>
                  </div>
                  <ul class="sidebar-latest-list">
                    {latestTopics.map((t) => (
                      <li key={t.id}>
                        <a href={`/topic/${t.id}`} class="sidebar-topic-title">{truncate(t.title, 25)}</a>
                        <span class="sidebar-topic-author">（{t.user.displayName || t.user.username}）</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <div class="sidebar-group-card">
              <div class="sidebar-group-header">
                <img
                  src={resizeImage(topicData.user.avatarUrl, 80) || '/static/img/default-avatar.svg'}
                  alt=""
                  class="sidebar-group-icon"
                  style="border-radius: 50%;"
                />
                <div class="sidebar-group-info">
                  <a href={`/user/${topicData.user.username}`} class="sidebar-group-name">
                    {topicData.user.displayName || topicData.user.username}
                  </a>
                  <p class="sidebar-group-desc">@{topicData.user.username}</p>
                </div>
              </div>
              <div class="sidebar-group-stats">
                <a href={`/user/${topicData.user.username}`}>查看作者主页</a>
              </div>
            </div>
          )}
        </aside>
      </div>
    </Layout>
  )
})

// 发表评论
topic.post('/:id/comment', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  // 检查话题是否存在
  const topicResult = await db
    .select()
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1)

  if (topicResult.length === 0) {
    return c.notFound()
  }

  const body = await c.req.parseBody()
  const content = body.content as string
  const replyToId = body.replyToId as string | undefined

  if (!content || !content.trim()) {
    return c.redirect(`/topic/${topicId}`)
  }

  const now = new Date()
  const commentId = generateId()

  const htmlContent = `<p>${content.trim().replace(/\n/g, '</p><p>')}</p>`

  await db.insert(comments).values({
    id: commentId,
    topicId,
    userId: user.id,
    content: htmlContent,
    replyToId: replyToId || null,
    createdAt: now,
    updatedAt: now,
  })

  // 更新话题的 updatedAt
  await db
    .update(topics)
    .set({ updatedAt: now })
    .where(eq(topics.id, topicId))

  // 提醒话题作者
  await createNotification(db, {
    userId: topicResult[0].userId,
    actorId: user.id,
    type: 'reply',
    topicId,
  })

  // 如果是回复某条评论，提醒该评论作者
  let replyCommentData: { userId: string } | null = null
  if (replyToId) {
    const replyComment = await db.select({ userId: comments.userId }).from(comments).where(eq(comments.id, replyToId)).limit(1)
    if (replyComment.length > 0) {
      replyCommentData = replyComment[0]
      if (replyComment[0].userId !== topicResult[0].userId) {
        await createNotification(db, {
          userId: replyComment[0].userId,
          actorId: user.id,
          type: 'comment_reply',
          topicId,
          commentId: replyToId,
        })
      }
    }
  }

  // Token mining: reward_reply + reward_liked
  c.executionCtx.waitUntil((async () => {
    try {
      const { tryMineReward } = await import('../lib/token')
      const groupId = topicResult[0].groupId
      if (!groupId) return
      // Commenter gets reward_reply
      await tryMineReward(db, groupId, user.id, 'reward_reply', commentId)
      // Author gets reward_liked (topic author or parent comment author)
      const authorId = replyCommentData ? replyCommentData.userId : topicResult[0].userId
      if (authorId !== user.id) {
        await tryMineReward(db, groupId, authorId, 'reward_liked', commentId)
      }
    } catch (e) {
      console.error('[Token] Mining reward_reply failed:', e)
    }
  })())

  // AP: deliver Create(Note) to followers
  const baseUrlForAp = c.env.APP_URL || new URL(c.req.url).origin

  // Check if this topic belongs to a mirror group — deliver comment to remote group
  const remoteGroupForComment = topicResult[0].groupId
    ? await db.select()
        .from(remoteGroups)
        .where(eq(remoteGroups.localGroupId, topicResult[0].groupId))
        .limit(1)
    : []

  if (remoteGroupForComment.length > 0) {
    const rg = remoteGroupForComment[0]
    c.executionCtx.waitUntil((async () => {
      try {
        const apUsername = await getApUsername(db, user.id)
        if (!apUsername) return

        const { privateKeyPem } = await ensureKeyPair(db, user.id)
        const actorUrl = `${baseUrlForAp}/ap/users/${apUsername}`
        const noteId = `${baseUrlForAp}/ap/comments/${commentId}`
        const commentUrl = `${baseUrlForAp}/topic/${topicId}#comment-${commentId}`
        const published = new Date().toISOString()

        // Determine inReplyTo
        let inReplyTo: string
        if (replyToId) {
          // Check if parent comment has a remote mastodonStatusId
          const parentComment = await db.select({ mastodonStatusId: comments.mastodonStatusId })
            .from(comments)
            .where(eq(comments.id, replyToId))
            .limit(1)
          if (parentComment.length > 0 && parentComment[0].mastodonStatusId?.startsWith('http')) {
            inReplyTo = parentComment[0].mastodonStatusId
          } else {
            inReplyTo = `${baseUrlForAp}/ap/comments/${replyToId}`
          }
        } else {
          // Reply to topic — use topic's mastodonStatusId if remote, else AP note URL
          if (topicResult[0].mastodonStatusId?.startsWith('http')) {
            inReplyTo = topicResult[0].mastodonStatusId
          } else {
            inReplyTo = `${baseUrlForAp}/ap/notes/${topicId}`
          }
        }

        const note = {
          id: noteId,
          type: 'Note',
          attributedTo: actorUrl,
          inReplyTo,
          content: htmlContent,
          url: commentUrl,
          published,
          to: ['https://www.w3.org/ns/activitystreams#Public'],
          cc: [rg.actorUri, `${actorUrl}/followers`],
          tag: [{
            type: 'Mention',
            href: rg.actorUri,
            name: `@${rg.actorUri.split('/').pop()}@${rg.domain}`,
          }],
        }

        const activity = {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${noteId}/activity`,
          type: 'Create',
          actor: actorUrl,
          published,
          to: ['https://www.w3.org/ns/activitystreams#Public'],
          cc: [rg.actorUri, `${actorUrl}/followers`],
          object: note,
        }

        await signAndDeliver(actorUrl, privateKeyPem, rg.inboxUrl, activity)
      } catch (e) {
        console.error('[Remote Group] Failed to deliver comment to remote group:', e)
      }
    })())
  } else {
    c.executionCtx.waitUntil(
      deliverCommentToFollowers(db, baseUrlForAp, user.id, commentId, topicId, htmlContent, replyToId || null)
    )
  }

  // AP: also deliver reply directly to remote origin inbox if topic/comment originated from fediverse
  if (topicResult[0].mastodonStatusId && topicResult[0].mastodonStatusId.startsWith('http')) {
    const remoteDomain = (() => { try { return new URL(topicResult[0].mastodonStatusId!).origin } catch { return null } })()
    // Prefer replying to the remote status/comment URL to keep threading on origin
    let remoteInReplyTo: string | null = topicResult[0].mastodonStatusId
    if (replyToId) {
      const parentComment = commentMap.get(replyToId)
      if (parentComment?.mastodonStatusId?.startsWith('http')) {
        remoteInReplyTo = parentComment.mastodonStatusId
      }
    }
    if (remoteDomain) {
      const actorUrl = `${baseUrlForAp}/ap/users/${user.username}`
      const { privateKeyPem } = await ensureKeyPair(db, user.id)
      const noteId = `${baseUrlForAp}/ap/comments/${commentId}`
      const commentUrl = `${baseUrlForAp}/topic/${topicId}#comment-${commentId}`
      const published = new Date().toISOString()

      // Resolve remote actor + inbox for the target status to ensure Mastodon accepts the reply
      let targetActor: string | null = null
      let remoteInbox: string | null = null
      let remoteSharedInbox: string | null = null

      if (remoteInReplyTo) {
        try {
          const resp = await fetch(remoteInReplyTo, { headers: { Accept: 'application/activity+json' } })
          if (resp.ok) {
            const remoteNote = await resp.json()
            const attributed = Array.isArray(remoteNote.attributedTo)
              ? remoteNote.attributedTo[0]
              : remoteNote.attributedTo
            const actorId = typeof attributed === 'string'
              ? attributed
              : (typeof remoteNote.actor === 'string' ? remoteNote.actor : null)

            if (actorId) {
              targetActor = actorId
              const remoteActor = await fetchActor(actorId)
              if (remoteActor) {
                remoteSharedInbox = remoteActor.endpoints?.sharedInbox || null
                remoteInbox = remoteActor.inbox || null
              }
            }
          } else {
            console.error('AP direct reply: fetch remote note failed', resp.status)
          }
        } catch (e) {
          console.error('AP direct reply: fetch remote note error', e)
        }
      }

      const inboxToUse = remoteSharedInbox || remoteInbox || `${remoteDomain}/inbox`
      const inReplyTo = remoteInReplyTo || (replyToId
        ? `${baseUrlForAp}/ap/comments/${replyToId}`
        : `${baseUrlForAp}/ap/notes/${topicId}`)

      const to = ['https://www.w3.org/ns/activitystreams#Public']
      const cc = [`${actorUrl}/followers`]
      if (targetActor) {
        to.push(targetActor)
        cc.push(targetActor)
      }

      const note = {
        id: noteId,
        type: 'Note',
        attributedTo: actorUrl,
        inReplyTo,
        content: htmlContent,
        url: commentUrl,
        published,
        to,
        cc,
      }

      const activity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${noteId}/activity`,
        type: 'Create',
        actor: actorUrl,
        published,
        to,
        cc,
        object: note,
      }

      c.executionCtx.waitUntil(
        signAndDeliver(actorUrl, privateKeyPem, inboxToUse, activity)
          .catch(e => console.error('AP direct reply deliver failed:', e))
      )
    }
  }

  // Nostr: broadcast comment as Kind 1 event with threading tags
  if (isNostrEnabled(c.env) && user.nostrSyncEnabled && user.nostrPrivEncrypted) {
    c.executionCtx.waitUntil((async () => {
      try {
        const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
        const textContent = stripHtml(htmlContent)
        const noteContent = `${textContent}\n\n🔗 ${baseUrl}/topic/${topicId}#comment-${commentId}`

        const tags: string[][] = [
          ['r', `${baseUrl}/topic/${topicId}`],
          ['client', c.env.APP_NAME || 'NeoGroup'],
        ]

        // Collect mentioned pubkeys for p tags (NIP-10 threading notifications)
        const mentionedPubkeys = new Set<string>()

        // Topic author's Nostr pubkey
        if (topicResult[0].nostrAuthorPubkey) {
          mentionedPubkeys.add(topicResult[0].nostrAuthorPubkey)
        } else {
          const topicAuthor = await db.select({ nostrPubkey: users.nostrPubkey })
            .from(users).where(eq(users.id, topicResult[0].userId)).limit(1)
          if (topicAuthor[0]?.nostrPubkey) mentionedPubkeys.add(topicAuthor[0].nostrPubkey)
        }

        // Thread linking: reference topic's Nostr event as root
        if (topicResult[0].nostrEventId) {
          tags.push(['e', topicResult[0].nostrEventId, '', 'root'])
        }

        // If replying to a comment, reference it as reply + get author pubkey
        if (replyToId) {
          const parentComment = await db.select({
            nostrEventId: comments.nostrEventId,
            nostrPubkey: users.nostrPubkey,
          })
            .from(comments)
            .leftJoin(users, eq(comments.userId, users.id))
            .where(eq(comments.id, replyToId))
            .limit(1)
          if (parentComment.length > 0) {
            if (parentComment[0].nostrEventId) {
              tags.push(['e', parentComment[0].nostrEventId, '', 'reply'])
            }
            if (parentComment[0].nostrPubkey) {
              mentionedPubkeys.add(parentComment[0].nostrPubkey)
            }
          }
        }

        // Add p tags for all mentioned authors (excluding self)
        for (const pk of mentionedPubkeys) {
          if (pk !== user.nostrPubkey) {
            tags.push(['p', pk])
          }
        }

        const event = await buildSignedEvent({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          kind: 1,
          content: noteContent,
          tags,
        })

        await db.update(comments)
          .set({ nostrEventId: event.id })
          .where(eq(comments.id, commentId))

        await c.env.NOSTR_QUEUE!.send({ events: [event] })
        console.log('[Nostr] Queued comment event:', event.id)
      } catch (e) {
        console.error('[Nostr] Failed to publish comment:', e)
      }
    })())
  }

  return c.redirect(`/topic/${topicId}`)
})

// 转发话题（Mastodon + Nostr）
topic.post('/:id/repost', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  // 查用户 auth 能力
  const authProvider = await db.query.authProviders.findFirst({
    where: and(eq(authProviders.userId, user.id), eq(authProviders.providerType, 'mastodon')),
  })
  const hasMastodonAuth = !!(authProvider?.accessToken)
  const hasNostr = !!(user.nostrSyncEnabled && user.nostrPrivEncrypted)

  if (!hasMastodonAuth && !hasNostr) {
    return c.redirect(`/topic/${topicId}`)
  }

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  // Mastodon boost
  if (hasMastodonAuth) {
    try {
      const userDomain = authProvider!.providerId.split('@')[1]
      const noteUrl = `${baseUrl}/ap/notes/${topicId}`
      const localStatusId = await resolveStatusByUrl(userDomain, authProvider!.accessToken!, noteUrl)
      if (localStatusId) {
        await reblogStatus(userDomain, authProvider!.accessToken!, localStatusId)
      } else {
        console.error('Failed to resolve AP Note for repost:', noteUrl)
      }
    } catch (e) {
      console.error('Failed to repost topic to Mastodon:', e)
    }
  }

  // Nostr Kind 6 repost
  if (isNostrEnabled(c.env) && hasNostr) {
    const topicData = await db
      .select({ nostrEventId: topics.nostrEventId, nostrAuthorPubkey: topics.nostrAuthorPubkey })
      .from(topics)
      .where(eq(topics.id, topicId))
      .limit(1)

    if (topicData.length > 0 && topicData[0].nostrEventId) {
      c.executionCtx.waitUntil((async () => {
        try {
          const tags: string[][] = [
            ['e', topicData[0].nostrEventId!, '', 'mention'],
          ]
          if (topicData[0].nostrAuthorPubkey) {
            tags.push(['p', topicData[0].nostrAuthorPubkey!])
          }
          const event = await buildSignedEvent({
            privEncrypted: user.nostrPrivEncrypted!,
            iv: user.nostrPrivIv!,
            masterKey: c.env.NOSTR_MASTER_KEY!,
            kind: 6,
            content: '',
            tags,
          })
          await c.env.NOSTR_QUEUE!.send({ events: [event] })
          console.log('[Nostr] Queued Kind 6 repost for topic:', topicId)
        } catch (e) {
          console.error('[Nostr] Failed to send Kind 6 repost:', e)
        }
      })())
    }
  }

  // 记录转发（避免重复）
  const existingRepost = await db
    .select()
    .from(topicReposts)
    .where(and(eq(topicReposts.topicId, topicId), eq(topicReposts.userId, user.id)))
    .limit(1)
  if (existingRepost.length === 0) {
    await db.insert(topicReposts).values({
      id: generateId(),
      topicId,
      userId: user.id,
      createdAt: new Date(),
    })

    // 提醒话题作者
    const topicAuthor = await db
      .select({ userId: topics.userId })
      .from(topics)
      .where(eq(topics.id, topicId))
      .limit(1)
    if (topicAuthor.length > 0) {
      await createNotification(db, {
        userId: topicAuthor[0].userId,
        actorId: user.id,
        type: 'topic_repost',
        topicId,
      })
    }
  }

  // AP Announce to user's followers
  c.executionCtx.waitUntil(
    announceToUserFollowers(db, baseUrl, user.id, topicId)
      .catch(e => console.error('[AP Announce] User repost failed:', e))
  )

  // Redirect back: if came from timeline, go back there
  const referer = c.req.header('Referer') || ''
  if (referer.includes('/timeline')) {
    return c.redirect('/timeline')
  }
  return c.redirect(`/topic/${topicId}`)
})

// 取消转发话题
topic.post('/:id/unrepost', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  // Mastodon unrepost (if user has Mastodon auth)
  const authProvider = await db.query.authProviders.findFirst({
    where: and(eq(authProviders.userId, user.id), eq(authProviders.providerType, 'mastodon')),
  })

  if (authProvider?.accessToken) {
    const userDomain = authProvider.providerId.split('@')[1]
    const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
    const noteUrl = `${baseUrl}/ap/notes/${topicId}`

    try {
      const localStatusId = await resolveStatusByUrl(userDomain, authProvider.accessToken, noteUrl)
      if (localStatusId) {
        await unreblogStatus(userDomain, authProvider.accessToken, localStatusId)
      }
    } catch (e) {
      console.error('Failed to unrepost topic on Mastodon:', e)
    }
  }

  // Delete DB record (works for both Mastodon and Nostr users)
  await db
    .delete(topicReposts)
    .where(and(eq(topicReposts.topicId, topicId), eq(topicReposts.userId, user.id)))

  // Redirect back: if came from timeline, go back there
  const referer = c.req.header('Referer') || ''
  if (referer.includes('/timeline')) {
    return c.redirect('/timeline')
  }
  return c.redirect(`/topic/${topicId}`)
})

// 喜欢话题
topic.post('/:id/like', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  // 检查是否已喜欢
  const existingLike = await db
    .select()
    .from(topicLikes)
    .where(and(eq(topicLikes.topicId, topicId), eq(topicLikes.userId, user.id)))
    .limit(1)

  if (existingLike.length > 0) {
    await db
      .delete(topicLikes)
      .where(and(eq(topicLikes.topicId, topicId), eq(topicLikes.userId, user.id)))
  } else {
    await db.insert(topicLikes).values({
      id: generateId(),
      topicId,
      userId: user.id,
      createdAt: new Date(),
    })

    // 提醒话题作者
    const topicData = await db.select({ userId: topics.userId, groupId: topics.groupId, nostrEventId: topics.nostrEventId, nostrAuthorPubkey: topics.nostrAuthorPubkey }).from(topics).where(eq(topics.id, topicId)).limit(1)
    if (topicData.length > 0) {
      await createNotification(db, {
        userId: topicData[0].userId,
        actorId: user.id,
        type: 'topic_like',
        topicId,
      })

      // Token mining: reward_like + reward_liked
      c.executionCtx.waitUntil((async () => {
        try {
          const { tryMineReward } = await import('../lib/token')
          if (!topicData[0].groupId) return
          await tryMineReward(db, topicData[0].groupId, user.id, 'reward_like', topicId)
          if (topicData[0].userId !== user.id) {
            await tryMineReward(db, topicData[0].groupId, topicData[0].userId, 'reward_liked', topicId)
          }
        } catch (e) {
          console.error('[Token] Mining reward_like failed:', e)
        }
      })())

      // Nostr Kind 7 reaction
      if (isNostrEnabled(c.env) && user.nostrSyncEnabled && user.nostrPrivEncrypted
          && topicData[0].nostrEventId) {
        c.executionCtx.waitUntil((async () => {
          try {
            const tags: string[][] = [
              ['e', topicData[0].nostrEventId!],
            ]
            if (topicData[0].nostrAuthorPubkey) {
              tags.push(['p', topicData[0].nostrAuthorPubkey!])
            }
            const event = await buildSignedEvent({
              privEncrypted: user.nostrPrivEncrypted!,
              iv: user.nostrPrivIv!,
              masterKey: c.env.NOSTR_MASTER_KEY!,
              kind: 7,
              content: '+',
              tags,
            })
            await c.env.NOSTR_QUEUE!.send({ events: [event] })
            console.log('[Nostr] Queued Kind 7 reaction for topic:', topicId)
          } catch (e) {
            console.error('[Nostr] Failed to send Kind 7 reaction:', e)
          }
        })())
      }
    }
  }

  // Redirect back: if came from timeline, go back there
  const referer = c.req.header('Referer') || ''
  if (referer.includes('/timeline')) {
    return c.redirect('/timeline')
  }
  return c.redirect(`/topic/${topicId}`)
})

// 转发评论到 Mastodon
topic.post('/:id/comment/:commentId/repost', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')
  const commentId = c.req.param('commentId')

  if (!user) {
    return c.redirect('/auth/login')
  }

  const commentResult = await db
    .select({ mastodonStatusId: comments.mastodonStatusId, mastodonDomain: comments.mastodonDomain })
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1)

  if (commentResult.length === 0) {
    return c.redirect(`/topic/${topicId}`)
  }

  const authProvider = await db.query.authProviders.findFirst({
    where: and(eq(authProviders.userId, user.id), eq(authProviders.providerType, 'mastodon')),
  })

  if (!authProvider?.accessToken) {
    return c.redirect(`/topic/${topicId}`)
  }

  const userDomain = authProvider.providerId.split('@')[1]
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  try {
    let localStatusId: string | null = null

    if (commentResult[0].mastodonStatusId && commentResult[0].mastodonDomain) {
      // 有 Mastodon status → 跨实例 resolve
      localStatusId = await resolveStatusId(
        userDomain, authProvider.accessToken,
        commentResult[0].mastodonDomain, commentResult[0].mastodonStatusId
      )
    }

    if (!localStatusId) {
      // Fallback: 用 AP URL resolve
      const apUrl = `${baseUrl}/ap/comments/${commentId}`
      localStatusId = await resolveStatusByUrl(userDomain, authProvider.accessToken, apUrl)
    }

    if (!localStatusId) {
      console.error('Failed to resolve comment for repost')
      return c.redirect(`/topic/${topicId}#comment-${commentId}`)
    }
    await reblogStatus(userDomain, authProvider.accessToken, localStatusId)

    // 记录转发（避免重复）
    const existingRepost = await db
      .select()
      .from(commentReposts)
      .where(and(eq(commentReposts.commentId, commentId), eq(commentReposts.userId, user.id)))
      .limit(1)
    if (existingRepost.length === 0) {
      await db.insert(commentReposts).values({
        id: generateId(),
        commentId,
        userId: user.id,
        createdAt: new Date(),
      })

      // 提醒评论作者
      const commentData = await db
        .select({ userId: comments.userId })
        .from(comments)
        .where(eq(comments.id, commentId))
        .limit(1)
      if (commentData.length > 0) {
        await createNotification(db, {
          userId: commentData[0].userId,
          actorId: user.id,
          type: 'comment_repost',
          topicId,
          commentId,
        })
      }
    }
  } catch (e) {
    console.error('Failed to repost comment to Mastodon:', e)
  }

  return c.redirect(`/topic/${topicId}#comment-${commentId}`)
})

// 取消转发评论到 Mastodon
topic.post('/:id/comment/:commentId/unrepost', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')
  const commentId = c.req.param('commentId')

  if (!user) {
    return c.redirect('/auth/login')
  }

  const commentResult = await db
    .select({ mastodonStatusId: comments.mastodonStatusId, mastodonDomain: comments.mastodonDomain })
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1)

  if (commentResult.length === 0) {
    return c.redirect(`/topic/${topicId}`)
  }

  const authProvider = await db.query.authProviders.findFirst({
    where: and(eq(authProviders.userId, user.id), eq(authProviders.providerType, 'mastodon')),
  })

  if (!authProvider?.accessToken) {
    return c.redirect(`/topic/${topicId}`)
  }

  const userDomain = authProvider.providerId.split('@')[1]
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  try {
    let localStatusId: string | null = null

    if (commentResult[0].mastodonStatusId && commentResult[0].mastodonDomain) {
      localStatusId = await resolveStatusId(
        userDomain, authProvider.accessToken,
        commentResult[0].mastodonDomain, commentResult[0].mastodonStatusId
      )
    }

    if (!localStatusId) {
      const apUrl = `${baseUrl}/ap/comments/${commentId}`
      localStatusId = await resolveStatusByUrl(userDomain, authProvider.accessToken, apUrl)
    }

    if (!localStatusId) {
      console.error('Failed to resolve comment for unrepost')
      return c.redirect(`/topic/${topicId}#comment-${commentId}`)
    }

    await unreblogStatus(userDomain, authProvider.accessToken, localStatusId)

    await db
      .delete(commentReposts)
      .where(and(eq(commentReposts.commentId, commentId), eq(commentReposts.userId, user.id)))
  } catch (e) {
    console.error('Failed to unrepost comment to Mastodon:', e)
  }

  return c.redirect(`/topic/${topicId}#comment-${commentId}`)
})

// 点赞评论
topic.post('/:id/comment/:commentId/like', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')
  const commentId = c.req.param('commentId')

  if (!user) {
    return c.redirect('/auth/login')
  }

  // 检查评论是否存在
  const commentResult = await db
    .select()
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1)

  if (commentResult.length === 0) {
    return c.redirect(`/topic/${topicId}`)
  }

  // 检查是否已点赞
  const existingLike = await db
    .select()
    .from(commentLikes)
    .where(and(eq(commentLikes.commentId, commentId), eq(commentLikes.userId, user.id)))
    .limit(1)

  if (existingLike.length > 0) {
    // 已点赞则取消
    await db
      .delete(commentLikes)
      .where(and(eq(commentLikes.commentId, commentId), eq(commentLikes.userId, user.id)))
  } else {
    // 未点赞则添加
    await db.insert(commentLikes).values({
      id: generateId(),
      commentId,
      userId: user.id,
      createdAt: new Date(),
    })

    // 提醒评论作者
    await createNotification(db, {
      userId: commentResult[0].userId,
      actorId: user.id,
      type: 'comment_like',
      topicId,
      commentId,
    })

    // Token mining: reward_like + reward_liked
    c.executionCtx.waitUntil((async () => {
      try {
        const { tryMineReward } = await import('../lib/token')
        // Get topic's groupId
        const topicForMining = await db.select({ groupId: topics.groupId }).from(topics).where(eq(topics.id, topicId)).limit(1)
        if (topicForMining.length === 0 || !topicForMining[0].groupId) return
        const groupId = topicForMining[0].groupId
        await tryMineReward(db, groupId, user.id, 'reward_like', commentId)
        if (commentResult[0].userId !== user.id) {
          await tryMineReward(db, groupId, commentResult[0].userId, 'reward_liked', commentId)
        }
      } catch (e) {
        console.error('[Token] Mining reward_like (comment) failed:', e)
      }
    })())

    // Nostr Kind 7 reaction for comment
    if (isNostrEnabled(c.env) && user.nostrSyncEnabled && user.nostrPrivEncrypted
        && commentResult[0].nostrEventId) {
      c.executionCtx.waitUntil((async () => {
        try {
          const event = await buildSignedEvent({
            privEncrypted: user.nostrPrivEncrypted!,
            iv: user.nostrPrivIv!,
            masterKey: c.env.NOSTR_MASTER_KEY!,
            kind: 7,
            content: '+',
            tags: [
              ['e', commentResult[0].nostrEventId!],
              ['p', commentResult[0].userId],
            ],
          })
          await c.env.NOSTR_QUEUE!.send({ events: [event] })
        } catch (e) {
          console.error('[Nostr] Failed to send Kind 7 reaction for comment:', e)
        }
      })())
    }
  }

  return c.redirect(`/topic/${topicId}#comment-${commentId}`)
})

// 编辑评论
topic.post('/:id/comment/:commentId/edit', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')
  const commentId = c.req.param('commentId')

  if (!user) {
    return c.redirect('/auth/login')
  }

  const commentResult = await db
    .select()
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1)

  if (commentResult.length === 0 || commentResult[0].userId !== user.id) {
    return c.redirect(`/topic/${topicId}`)
  }

  const body = await c.req.parseBody()
  const content = body.content as string

  if (!content || !content.trim()) {
    return c.redirect(`/topic/${topicId}`)
  }

  await db.update(comments)
    .set({
      content: `<p>${content.trim().replace(/\n/g, '</p><p>')}</p>`,
      updatedAt: new Date(),
    })
    .where(eq(comments.id, commentId))

  return c.redirect(`/topic/${topicId}#comment-${commentId}`)
})

// 删除评论
topic.post('/:id/comment/:commentId/delete', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')
  const commentId = c.req.param('commentId')

  if (!user) return c.redirect('/auth/login')

  const comment = await db.select().from(comments).where(eq(comments.id, commentId)).limit(1)
  if (comment.length === 0 || (comment[0].userId !== user.id && !isSuperAdmin(user))) {
    return c.redirect(`/topic/${topicId}`)
  }

  // If this comment was posted to a Mastodon thread using the user's local AP identity and also synced as a Mastodon status, delete that status too
  if (comment[0].mastodonStatusId && comment[0].mastodonDomain) {
    const authProvider = await db.query.authProviders.findFirst({
      where: and(eq(authProviders.userId, user.id), eq(authProviders.providerType, 'mastodon')),
    })

    if (authProvider?.accessToken) {
      try {
        await deleteStatus(comment[0].mastodonDomain, authProvider.accessToken, comment[0].mastodonStatusId)
      } catch (e) {
        console.error('Failed to delete Mastodon status for comment', commentId, e)
      }
    }
  }

  // If this comment was federated as a reply to a remote Mastodon thread, send Delete activity
  const topicResult = await db
    .select({ mastodonStatusId: topics.mastodonStatusId })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1)

  const baseUrlForAp = c.env.APP_URL || new URL(c.req.url).origin

  if (topicResult.length > 0 && topicResult[0].mastodonStatusId?.startsWith('http')) {
    // Determine which remote object we were replying to (topic or parent comment)
    let remoteInReplyTo: string | null = topicResult[0].mastodonStatusId
    if (comment[0].replyToId) {
      const parent = await db.select({ mastodonStatusId: comments.mastodonStatusId })
        .from(comments)
        .where(eq(comments.id, comment[0].replyToId))
        .limit(1)
      if (parent.length > 0 && parent[0].mastodonStatusId?.startsWith('http')) {
        remoteInReplyTo = parent[0].mastodonStatusId
      }
    }

    // Fetch remote note to locate target actor + inbox
    let targetActor: string | null = null
    let remoteInbox: string | null = null
    let remoteSharedInbox: string | null = null
    const remoteDomain = (() => { try { return new URL(remoteInReplyTo || topicResult[0].mastodonStatusId!).origin } catch { return null } })()

    if (remoteInReplyTo) {
      try {
        const resp = await fetch(remoteInReplyTo, { headers: { Accept: 'application/activity+json' } })
        if (resp.ok) {
          const remoteNote = await resp.json()
          const attributed = Array.isArray(remoteNote.attributedTo) ? remoteNote.attributedTo[0] : remoteNote.attributedTo
          const actorId = typeof attributed === 'string' ? attributed : (typeof remoteNote.actor === 'string' ? remoteNote.actor : null)
          if (actorId) {
            targetActor = actorId
            const remoteActor = await fetchActor(actorId)
            if (remoteActor) {
              remoteSharedInbox = remoteActor.endpoints?.sharedInbox || null
              remoteInbox = remoteActor.inbox || null
            }
          }
        }
      } catch (e) {
        console.error('AP delete reply: fetch remote note error', e)
      }
    }

    const inboxToUse = remoteSharedInbox || remoteInbox || (remoteDomain ? `${remoteDomain}/inbox` : null)

    if (inboxToUse) {
      const actorUrl = `${baseUrlForAp}/ap/users/${user.username}`
      const { privateKeyPem } = await ensureKeyPair(db, user.id)
      const noteId = `${baseUrlForAp}/ap/comments/${commentId}`

      const to = ['https://www.w3.org/ns/activitystreams#Public']
      const cc = [`${actorUrl}/followers`]
      if (targetActor) {
        to.push(targetActor)
        cc.push(targetActor)
      }

      const activity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${noteId}/delete`,
        type: 'Delete',
        actor: actorUrl,
        to,
        cc,
        object: noteId,
      }

      c.executionCtx.waitUntil(
        signAndDeliver(actorUrl, privateKeyPem, inboxToUse, activity)
          .catch(e => console.error('AP delete reply deliver failed:', e))
      )
    }
  }

  // 删除评论的点赞、转发记录，再删除评论
  await db.delete(commentLikes).where(eq(commentLikes.commentId, commentId))
  await db.delete(commentReposts).where(eq(commentReposts.commentId, commentId))
  await db.delete(comments).where(eq(comments.id, commentId))

  return c.redirect(`/topic/${topicId}`)
})

// 删除话题
topic.post('/:id/delete', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')

  if (!user) return c.redirect('/auth/login')

  const topicResult = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1)
  if (topicResult.length === 0) return c.redirect(`/topic/${topicId}`)

  const isAdmin = isSuperAdmin(user)
  if (topicResult[0].userId !== user.id && !isAdmin) {
    return c.redirect(`/topic/${topicId}`)
  }

  const groupId = topicResult[0].groupId

  // 普通用户：有评论时不允许删除
  if (!isAdmin) {
    const commentCount = await db.select({ count: sql<number>`count(*)` }).from(comments).where(eq(comments.topicId, topicId))
    if (commentCount[0].count > 0) {
      return c.redirect(`/topic/${topicId}`)
    }
  }

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  // AP Delete: send Delete activity to all followers
  if (topicResult[0].userId === user.id) {
    c.executionCtx.waitUntil((async () => {
      try {
        const apUsername = await getApUsername(db, user.id)
        if (!apUsername) return

        const { privateKeyPem } = await ensureKeyPair(db, user.id)
        const actorUrl = `${baseUrl}/ap/users/${apUsername}`
        const noteId = `${baseUrl}/ap/notes/${topicId}`

        const followers = await db.select().from(apFollowers).where(eq(apFollowers.userId, user.id))
        if (followers.length === 0) return

        const activity = {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${noteId}/delete`,
          type: 'Delete',
          actor: actorUrl,
          to: ['https://www.w3.org/ns/activitystreams#Public'],
          cc: [`${actorUrl}/followers`],
          object: noteId,
        }

        const inboxes = new Set<string>()
        for (const f of followers) {
          const inbox = f.sharedInboxUrl || f.inboxUrl
          if (inbox) inboxes.add(inbox)
        }

        for (const inbox of inboxes) {
          try {
            await signAndDeliver(actorUrl, privateKeyPem, inbox, activity)
          } catch (e) {
            console.error(`AP topic delete deliver to ${inbox} failed:`, e)
          }
        }
      } catch (e) {
        console.error('[AP] Failed to deliver topic Delete:', e)
      }
    })())
  }

  // Nostr Kind 5: deletion event
  if (isNostrEnabled(c.env) && topicResult[0].nostrEventId && user.nostrSyncEnabled && user.nostrPrivEncrypted) {
    c.executionCtx.waitUntil((async () => {
      try {
        const event = await buildSignedEvent({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          kind: 5,
          content: '',
          tags: [['e', topicResult[0].nostrEventId!]],
        })
        await c.env.NOSTR_QUEUE!.send({ events: [event] })
        console.log('[Nostr] Queued Kind 5 deletion for topic:', topicId)
      } catch (e) {
        console.error('[Nostr] Failed to send Kind 5 deletion:', e)
      }
    })())
  }

  // 级联删除评论点赞 → 评论 → 话题点赞 → 话题
  const topicComments = await db.select({ id: comments.id }).from(comments).where(eq(comments.topicId, topicId))
  for (const comment of topicComments) {
    await db.delete(commentLikes).where(eq(commentLikes.commentId, comment.id))
    await db.delete(commentReposts).where(eq(commentReposts.commentId, comment.id))
  }
  await db.delete(comments).where(eq(comments.topicId, topicId))
  await db.delete(topicLikes).where(eq(topicLikes.topicId, topicId))
  await db.delete(topicReposts).where(eq(topicReposts.topicId, topicId))
  await db.delete(topics).where(eq(topics.id, topicId))

  return c.redirect(groupId ? `/group/${groupId}` : '/timeline')
})

// 编辑话题页面
topic.get('/:id/edit', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  const topicResult = await db
    .select({
      id: topics.id,
      groupId: topics.groupId,
      userId: topics.userId,
      title: topics.title,
      content: topics.content,
      group: {
        id: groups.id,
        name: groups.name,
        actorName: groups.actorName,
      },
    })
    .from(topics)
    .leftJoin(groups, eq(topics.groupId, groups.id))
    .where(eq(topics.id, topicId))
    .limit(1)

  if (topicResult.length === 0) {
    return c.notFound()
  }

  const topicData = topicResult[0]

  if (topicData.userId !== user.id) {
    return c.redirect(`/topic/${topicId}`)
  }

  return c.html(
    <Layout user={user} title={`编辑话题 - ${topicData.title}`} unreadCount={c.get('unreadNotificationCount')} siteName={c.env.APP_NAME}>
      <link href="https://cdn.jsdelivr.net/npm/quill@2.0.2/dist/quill.snow.css" rel="stylesheet" />
      <div class="new-topic-page">
        <div class="page-header">
          <h1>编辑话题</h1>
          <p class="page-subtitle">
            {topicData.group && (
              <><a href={`/group/${topicData.group.actorName || topicData.groupId}`}>{topicData.group.name}</a>{' · '}</>
            )}
            <a href={`/topic/${topicId}`}>返回话题</a>
          </p>
        </div>

        <form action={`/topic/${topicId}/edit`} method="POST" class="topic-form" id="topic-form">
          <div class="form-group">
            <label for="title">标题</label>
            <input type="text" id="title" name="title" required value={topicData.title} />
          </div>

          <div class="form-group">
            <label>内容</label>
            <div id="editor"></div>
            <input type="hidden" id="content" name="content" />
          </div>

          <div class="form-actions">
            <button type="submit" class="btn btn-primary">保存修改</button>
            <a href={`/topic/${topicId}`} class="btn">取消</a>
          </div>
        </form>
      </div>

      <script src="https://cdn.jsdelivr.net/npm/quill@2.0.2/dist/quill.js"></script>
      <script dangerouslySetInnerHTML={{
        __html: `
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

        // Toot 卡片内部 HTML
        function buildTootCardInner(data) {
          var avatar = data.authorAvatar ? '<img src="' + data.authorAvatar + '" alt="" class="toot-card-avatar" />' : '<div class="toot-card-avatar-placeholder"></div>';
          var images = '';
          if (data.attachments && data.attachments.length > 0) {
            images = '<div class="toot-card-images">' + data.attachments.slice(0, 2).map(function(a) {
              return '<img src="' + a.url + '" alt="' + (a.description || '') + '" />';
            }).join('') + '</div>';
          }
          var content = data.content || '';
          if (content.length > 200) content = content.slice(0, 200) + '...';
          return '<a href="' + data.url + '" target="_blank" rel="noopener" class="toot-card-link">'
            + '<div class="toot-card-header">'
            + avatar
            + '<div class="toot-card-author">'
            + '<span class="toot-card-name">' + (data.authorName || '') + '</span>'
            + '<span class="toot-card-handle">' + (data.authorHandle || '') + '</span>'
            + '</div>'
            + '</div>'
            + '<div class="toot-card-content">' + content + '</div>'
            + images
            + '<div class="toot-card-footer">'
            + '<span class="toot-card-domain">' + (data.domain || '') + '</span>'
            + '</div>'
            + '</a>';
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

        // 注册自定义 Toot 卡片 Blot
        class TootCardBlot extends BlockEmbed {
          static create(data) {
            var node = super.create();
            node.setAttribute('contenteditable', 'false');
            node.dataset.toot = JSON.stringify(data);
            node.innerHTML = buildTootCardInner(data);
            return node;
          }
          static value(node) {
            try { return JSON.parse(node.dataset.toot); } catch(e) { return {}; }
          }
        }
        TootCardBlot.blotName = 'toot-card';
        TootCardBlot.tagName = 'DIV';
        TootCardBlot.className = 'toot-card';
        Quill.register(TootCardBlot);

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

        // 加载已有内容
        var existingContent = ${JSON.stringify(topicData.content || '')};
        if (existingContent) {
          quill.root.innerHTML = existingContent;
        }

        // 图片上传处理
        quill.getModule('toolbar').addHandler('image', function() {
          var input = document.createElement('input');
          input.setAttribute('type', 'file');
          input.setAttribute('accept', 'image/*');
          input.click();
          input.onchange = async function() {
            var file = input.files[0];
            if (file) await uploadImage(file);
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

        // 检测是否是 Mastodon toot URL
        function isMastodonTootUrl(url) {
          return /^https?:\\/\\/[^\\/]+\\/@[^\\/]+\\/\\d+\\/?$/.test(url) ||
                 /^https?:\\/\\/[^\\/]+\\/users\\/[^\\/]+\\/statuses\\/\\d+\\/?$/.test(url);
        }

        async function insertTootLink(url) {
          var range = quill.getSelection(true);
          var loadingText = '加载嘟文...';
          quill.insertText(range.index, loadingText, { color: '#999' });
          try {
            var res = await fetch('/api/toot-preview?url=' + encodeURIComponent(url));
            var data = await res.json();
            quill.deleteText(range.index, loadingText.length);
            if (data.authorHandle) {
              quill.insertEmbed(range.index, 'toot-card', data, Quill.sources.USER);
              quill.setSelection(range.index + 1);
            } else {
              quill.insertText(range.index, url, { link: url });
            }
          } catch (err) {
            quill.deleteText(range.index, loadingText.length);
            quill.insertText(range.index, url, { link: url });
          }
        }

        // 粘贴处理（NeoDB 链接 + Toot 链接 + 图片）- capture 阶段拦截，在 Quill 之前处理
        document.querySelector('#editor').addEventListener('paste', async function(e) {
          var text = (e.clipboardData ? e.clipboardData.getData('text/plain') : '') || '';
          text = text.trim();
          
          // 检查 NeoDB 链接
          if (text && /neodb\\.social\\/(movie|book|tv|music|game|podcast|album)\\//.test(text)) {
            e.preventDefault();
            e.stopPropagation();
            insertNeoDBLink(text);
            return;
          }
          
          // 检查 Mastodon toot 链接
          if (text && isMastodonTootUrl(text)) {
            e.preventDefault();
            e.stopPropagation();
            insertTootLink(text);
            return;
          }
          
          // 检查粘贴图片
          var items = e.clipboardData && e.clipboardData.items;
          if (!items) return;
          for (var i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image/') === 0) {
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

        document.getElementById('topic-form').addEventListener('submit', function(e) {
          var content = quill.root.innerHTML;
          document.getElementById('content').value = content === '<p><br></p>' ? '' : content;
        });
      ` }} />
    </Layout>
  )
})

// 保存编辑话题
topic.post('/:id/edit', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const topicId = c.req.param('id')

  if (!user) {
    return c.redirect('/auth/login')
  }

  const topicResult = await db
    .select()
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1)

  if (topicResult.length === 0) {
    return c.notFound()
  }

  if (topicResult[0].userId !== user.id) {
    return c.redirect(`/topic/${topicId}`)
  }

  const body = await c.req.parseBody()
  const title = body.title as string
  const content = body.content as string

  if (!title || !title.trim()) {
    return c.redirect(`/topic/${topicId}/edit`)
  }

  await db.update(topics)
    .set({
      title: title.trim(),
      content: content?.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(topics.id, topicId))

  return c.redirect(`/topic/${topicId}`)
})

export default topic
