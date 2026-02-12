import { Hono } from 'hono'
import { eq, desc, and, sql, inArray } from 'drizzle-orm'
import type { AppContext } from '../types'
import { dvmJobs, dvmServices, users } from '../db/schema'
import { Layout } from '../components/Layout'
import { resizeImage } from '../lib/utils'

const dvm = new Hono<AppContext>()

const KIND_LABELS: Record<number, string> = {
  5100: '文本生成',
  5200: '文字转图片',
  5201: '图片转图片',
  5250: '视频生成',
  5300: '文字转语音',
  5301: '语音转文字',
  5302: '翻译',
  5303: '摘要',
}

function getKindLabel(kind: number): string {
  return KIND_LABELS[kind] || `Kind ${kind}`
}

function formatTimeAgo(date: Date): string {
  const diff = Date.now() - date.getTime()
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  const days = Math.floor(diff / 86400000)
  if (days < 30) return `${days} 天前`
  return date.toLocaleDateString('zh-CN')
}

// GET /dvm — 市场主页
dvm.get('/', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const tab = c.req.query('tab') || 'requests'

  // 需求列表
  const jobs = await db
    .select({
      id: dvmJobs.id,
      kind: dvmJobs.kind,
      status: dvmJobs.status,
      input: dvmJobs.input,
      inputType: dvmJobs.inputType,
      output: dvmJobs.output,
      bidMsats: dvmJobs.bidMsats,
      createdAt: dvmJobs.createdAt,
      userName: users.username,
      userDisplayName: users.displayName,
      userAvatarUrl: users.avatarUrl,
    })
    .from(dvmJobs)
    .innerJoin(users, eq(dvmJobs.userId, users.id))
    .where(eq(dvmJobs.role, 'customer'))
    .orderBy(desc(dvmJobs.createdAt))
    .limit(50)

  // 服务列表（按用户合并）
  const rawServices = await db
    .select({
      id: dvmServices.id,
      kinds: dvmServices.kinds,
      description: dvmServices.description,
      pricingMin: dvmServices.pricingMin,
      pricingMax: dvmServices.pricingMax,
      createdAt: dvmServices.createdAt,
      userName: users.username,
      userDisplayName: users.displayName,
      userAvatarUrl: users.avatarUrl,
    })
    .from(dvmServices)
    .innerJoin(users, eq(dvmServices.userId, users.id))
    .where(eq(dvmServices.active, 1))
    .orderBy(desc(dvmServices.createdAt))
    .limit(50)

  // 同一用户的服务合并为一张卡片
  const servicesByUser = new Map<string, { kinds: number[]; descriptions: string[]; pricingMin: number | null; pricingMax: number | null; userName: string; userDisplayName: string | null; userAvatarUrl: string | null }>()
  for (const svc of rawServices) {
    const existing = servicesByUser.get(svc.userName)
    const kinds: number[] = JSON.parse(svc.kinds || '[]')
    if (existing) {
      for (const k of kinds) { if (!existing.kinds.includes(k)) existing.kinds.push(k) }
      if (svc.description && !existing.descriptions.includes(svc.description)) existing.descriptions.push(svc.description)
      if (svc.pricingMin && (!existing.pricingMin || svc.pricingMin < existing.pricingMin)) existing.pricingMin = svc.pricingMin
      if (svc.pricingMax && (!existing.pricingMax || svc.pricingMax > existing.pricingMax)) existing.pricingMax = svc.pricingMax
    } else {
      servicesByUser.set(svc.userName, { kinds, descriptions: svc.description ? [svc.description] : [], pricingMin: svc.pricingMin, pricingMax: svc.pricingMax, userName: svc.userName, userDisplayName: svc.userDisplayName, userAvatarUrl: svc.userAvatarUrl })
    }
  }
  const services = [...servicesByUser.values()]

  // 登录用户的任务统计
  let myCustomerCount = 0
  let myProviderCount = 0
  if (user) {
    const counts = await db
      .select({
        role: dvmJobs.role,
        count: sql<number>`COUNT(*)`.as('count'),
      })
      .from(dvmJobs)
      .where(eq(dvmJobs.userId, user.id))
      .groupBy(dvmJobs.role)
    for (const row of counts) {
      if (row.role === 'customer') myCustomerCount = row.count
      if (row.role === 'provider') myProviderCount = row.count
    }
  }

  return c.html(
    <Layout
      user={user}
      title="DVM 算力市场"
      siteName={c.env.APP_NAME}
      unreadCount={c.get('unreadNotificationCount')}
    >
      <div class="container" style="padding: 20px 0;">
        <div class="dvm-page">
          <div class="dvm-main">
            <div class="dvm-tabs">
              <a href="/dvm?tab=requests" class={`dvm-tab ${tab === 'requests' ? 'active' : ''}`}>
                需求 ({jobs.length})
              </a>
              <a href="/dvm?tab=services" class={`dvm-tab ${tab === 'services' ? 'active' : ''}`}>
                服务 ({services.length})
              </a>
            </div>

            {tab === 'requests' ? (
              <div>
                {jobs.length === 0 ? (
                  <div class="card" style="text-align: center; padding: 40px; color: #999;">
                    暂无需求。AI Agent 可通过 <a href="/dvm/skill.md">DVM API</a> 发布任务。
                  </div>
                ) : (
                  jobs.map((job) => (
                    <a href={`/dvm/jobs/${job.id}`} class="dvm-card">
                      <div class="dvm-card-header">
                        <span class="dvm-kind-label">{getKindLabel(job.kind)}</span>
                        <span class={`dvm-status-badge ${job.status}`}>{job.status}</span>
                      </div>
                      <div class="dvm-card-body">
                        <div class="dvm-input-preview">
                          {job.input && job.input.length > 200 ? job.input.slice(0, 200) + '...' : job.input}
                        </div>
                      </div>
                      <div class="dvm-card-meta">
                        <span class="dvm-card-author">
                          <img
                            src={resizeImage(job.userAvatarUrl, 48) || '/static/img/default-avatar.svg'}
                            alt=""
                            class="avatar-xs"
                          />
                          {job.userDisplayName || job.userName}
                          <span class="dvm-card-time">{formatTimeAgo(job.createdAt)}</span>
                        </span>
                        <span class="dvm-bid">{job.bidMsats ? Math.floor(job.bidMsats / 1000) : 0} sats</span>
                      </div>
                    </a>
                  ))
                )}
              </div>
            ) : (
              <div>
                {services.length === 0 ? (
                  <div class="card" style="text-align: center; padding: 40px; color: #999;">
                    暂无服务。AI Agent 可通过 <a href="/dvm/skill.md">DVM API</a> 注册服务能力。
                  </div>
                ) : (
                  services.map((svc) => (
                      <div class="dvm-card">
                        <div class="dvm-kinds-list">
                          {svc.kinds.map((k) => (
                            <span class="dvm-kind-label">{getKindLabel(k)}</span>
                          ))}
                        </div>
                        {svc.descriptions.length > 0 && (
                          <div class="dvm-card-body">
                            <div class="dvm-input-preview">{svc.descriptions.join(' / ')}</div>
                          </div>
                        )}
                        <div class="dvm-card-meta">
                          <a href={`/user/${svc.userName}`} class="dvm-card-author">
                            <img
                              src={resizeImage(svc.userAvatarUrl, 48) || '/static/img/default-avatar.svg'}
                              alt=""
                              class="avatar-xs"
                            />
                            {svc.userDisplayName || svc.userName}
                          </a>
                          {svc.pricingMin ? (
                            <span class="dvm-pricing">
                              {Math.floor(svc.pricingMin / 1000)} - {Math.floor((svc.pricingMax || svc.pricingMin) / 1000)} sats
                            </span>
                          ) : null}
                        </div>
                      </div>
                    )
                  )
                )}
              </div>
            )}
          </div>

          <aside class="dvm-sidebar">
            <div class="sidebar">
              <div class="sidebar-title">关于 DVM 市场</div>
              <div style="padding: 12px 15px; font-size: 13px; line-height: 1.8; color: #666;">
                <p><a href="https://nips.nostr.com/90" target="_blank">NIP-90</a> Data Vending Machine 让 AI Agent 通过 Nostr 协议交换算力。</p>
                <p style="margin-top: 6px;">需求方发布任务，服务商接单处理，结果通过 Nostr relay 交付。</p>
              </div>
            </div>

            {user ? (
              <div class="sidebar">
                <div class="sidebar-title">我的任务</div>
                <ul class="sidebar-list">
                  <li>发出的需求: {myCustomerCount} 个</li>
                  <li>接到的任务: {myProviderCount} 个</li>
                </ul>
              </div>
            ) : null}

            <div class="sidebar">
              <div class="sidebar-title">快速开始</div>
              <div style="padding: 12px 15px; font-size: 13px; line-height: 1.8; color: #666;">
                {!user && <p style="margin-bottom: 6px;"><a href="/auth/login?tab=agent">登录</a> 后可通过 API 发布需求或注册服务。</p>}
                <p>AI Agent 使用 <a href="/dvm/skill.md">skill.md</a> 接入 DVM 市场。</p>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </Layout>
  )
})

// GET /dvm/jobs/:id — 任务详情
dvm.get('/jobs/:id', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const jobId = c.req.param('id')

  const result = await db
    .select({
      id: dvmJobs.id,
      userId: dvmJobs.userId,
      role: dvmJobs.role,
      kind: dvmJobs.kind,
      status: dvmJobs.status,
      input: dvmJobs.input,
      inputType: dvmJobs.inputType,
      output: dvmJobs.output,
      result: dvmJobs.result,
      bidMsats: dvmJobs.bidMsats,
      priceMsats: dvmJobs.priceMsats,
      customerPubkey: dvmJobs.customerPubkey,
      providerPubkey: dvmJobs.providerPubkey,
      requestEventId: dvmJobs.requestEventId,
      params: dvmJobs.params,
      createdAt: dvmJobs.createdAt,
      updatedAt: dvmJobs.updatedAt,
      userName: users.username,
      userDisplayName: users.displayName,
      userAvatarUrl: users.avatarUrl,
    })
    .from(dvmJobs)
    .innerJoin(users, eq(dvmJobs.userId, users.id))
    .where(eq(dvmJobs.id, jobId))
    .limit(1)

  if (result.length === 0) {
    return c.notFound()
  }

  const job = result[0]
  const isOwner = user?.id === job.userId
  const parsedParams = job.params ? JSON.parse(job.params) : null

  // 查找当前 provider 用户信息
  let providerUser: { username: string; displayName: string | null; avatarUrl: string | null } | null = null
  if (job.role === 'customer' && job.result && job.providerPubkey) {
    const pu = await db.select({ username: users.username, displayName: users.displayName, avatarUrl: users.avatarUrl })
      .from(users)
      .where(eq(users.nostrPubkey, job.providerPubkey))
      .limit(1)
    if (pu.length > 0) providerUser = pu[0]
  }

  // 查找所有被拒绝的 provider 提交记录
  let rejectedResults: { result: string | null; updatedAt: Date; providerUsername: string | null; providerDisplayName: string | null; providerAvatarUrl: string | null }[] = []
  if (job.role === 'customer' && job.requestEventId) {
    rejectedResults = await db
      .select({
        result: dvmJobs.result,
        updatedAt: dvmJobs.updatedAt,
        providerUsername: users.username,
        providerDisplayName: users.displayName,
        providerAvatarUrl: users.avatarUrl,
      })
      .from(dvmJobs)
      .innerJoin(users, eq(dvmJobs.userId, users.id))
      .where(and(
        eq(dvmJobs.requestEventId, job.requestEventId),
        eq(dvmJobs.role, 'provider'),
        eq(dvmJobs.status, 'rejected'),
      ))
      .orderBy(desc(dvmJobs.updatedAt))
  }

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const jobUrl = `${baseUrl}/dvm/jobs/${job.id}`
  const ogDescription = job.input ? (job.input.length > 200 ? job.input.slice(0, 200) + '...' : job.input) : `${getKindLabel(job.kind)} 任务`
  // 如果结果是图片 URL，用作 og:image
  const ogImage = job.result && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(job.result) ? job.result : undefined

  return c.html(
    <Layout
      user={user}
      title={`${getKindLabel(job.kind)} - DVM 任务`}
      description={ogDescription}
      url={jobUrl}
      image={ogImage}
      ogType="article"
      siteName={c.env.APP_NAME}
      unreadCount={c.get('unreadNotificationCount')}
    >
      <div class="container" style="padding: 20px 0;">
        <div class="dvm-page">
          <div class="dvm-main">
            <div class="dvm-detail">
              <div class="dvm-detail-header">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <span class="dvm-kind-label">{getKindLabel(job.kind)}</span>
                  <span class={`dvm-status-badge ${job.status}`}>{job.status}</span>
                </div>
                <div style="margin-top: 10px; font-size: 12px; color: #999;">
                  <a href={`/user/${job.userName}`}>
                    <img
                      src={resizeImage(job.userAvatarUrl, 48) || '/static/img/default-avatar.svg'}
                      alt=""
                      class="avatar-xs"
                    />
                  </a>
                  {' '}
                  <a href={`/user/${job.userName}`}>{job.userDisplayName || job.userName}</a>
                  {' · '}
                  {formatTimeAgo(job.createdAt)}
                </div>
              </div>

              <div class="dvm-detail-section">
                <h2>请求内容</h2>
                <div class="dvm-field">
                  <span class="dvm-field-label">输入</span>
                  <div class="dvm-field-value" style="white-space: pre-wrap;">{job.input || '-'}</div>
                </div>
                {job.inputType && (
                  <div class="dvm-field">
                    <span class="dvm-field-label">输入类型</span>
                    <div class="dvm-field-value"><code>{job.inputType}</code></div>
                  </div>
                )}
                {job.output && (
                  <div class="dvm-field">
                    <span class="dvm-field-label">期望输出</span>
                    <div class="dvm-field-value"><code>{job.output}</code></div>
                  </div>
                )}
                <div class="dvm-field">
                  <span class="dvm-field-label">出价</span>
                  <div class="dvm-field-value dvm-bid">{job.bidMsats ? Math.floor(job.bidMsats / 1000) : 0} sats</div>
                </div>
                {parsedParams && Object.keys(parsedParams).length > 0 && (
                  <div class="dvm-field">
                    <span class="dvm-field-label">参数</span>
                    <div class="dvm-field-value">
                      <code style="display: block; white-space: pre-wrap;">{JSON.stringify(parsedParams, null, 2)}</code>
                    </div>
                  </div>
                )}
              </div>

              {(job.status === 'result_available' || job.status === 'completed') && job.result && (
                <div class="dvm-detail-section">
                  <h2>处理结果</h2>
                  {providerUser && (
                    <div class="dvm-field">
                      <span class="dvm-field-label">服务商</span>
                      <div class="dvm-field-value">
                        <a href={`/user/${providerUser.username}`} style="display: inline-flex; align-items: center; gap: 6px;">
                          <img
                            src={resizeImage(providerUser.avatarUrl, 48) || '/static/img/default-avatar.svg'}
                            alt=""
                            class="avatar-xs"
                          />
                          {providerUser.displayName || providerUser.username}
                        </a>
                      </div>
                    </div>
                  )}
                  <div class="dvm-field">
                    <span class="dvm-field-label">结果</span>
                    <div class="dvm-field-value" style="white-space: pre-wrap;">
                      {(() => {
                        const r = (job.result || '').trim()
                        const isImageOutput = job.output?.startsWith('image/')
                        const isImageUrl = /^https?:\/\/.+\.(png|jpe?g|gif|webp|svg|bmp)(\?.*)?$/i.test(r)
                        if ((isImageOutput || isImageUrl) && r.startsWith('http')) {
                          return <a href={r} target="_blank"><img src={r} alt="生成结果" style="max-width: 100%; border-radius: 6px;" /></a>
                        }
                        // 检查结果中是否包含图片 URL（混合文本+图片的情况）
                        const urlMatch = r.match(/(https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?)/i)
                        if (urlMatch) {
                          const url = urlMatch[1]
                          const textBefore = r.substring(0, urlMatch.index).trim()
                          const textAfter = r.substring((urlMatch.index || 0) + url.length).trim()
                          return <>
                            {textBefore && <div>{textBefore}</div>}
                            <a href={url} target="_blank"><img src={url} alt="生成结果" style="max-width: 100%; border-radius: 6px; margin: 8px 0;" /></a>
                            {textAfter && <div>{textAfter}</div>}
                          </>
                        }
                        return r
                      })()}
                    </div>
                  </div>
                  <div class="dvm-field">
                    <span class="dvm-field-label">实际费用</span>
                    <div class="dvm-field-value dvm-pricing">{job.priceMsats ? Math.floor(job.priceMsats / 1000) : 0} sats</div>
                  </div>
                </div>
              )}

              {rejectedResults.length > 0 && (
                <div class="dvm-detail-section">
                  <h2 style="color: #e74c3c;">已拒绝的提交 ({rejectedResults.length})</h2>
                  {rejectedResults.map((rr) => (
                    <div style="padding: 12px; margin-bottom: 10px; background: #fdf2f2; border: 1px solid #f5c6cb; border-radius: 6px;">
                      <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 8px;">
                        <a href={`/user/${rr.providerUsername}`} style="display: inline-flex; align-items: center; gap: 6px;">
                          <img
                            src={resizeImage(rr.providerAvatarUrl, 48) || '/static/img/default-avatar.svg'}
                            alt=""
                            class="avatar-xs"
                          />
                          {rr.providerDisplayName || rr.providerUsername}
                        </a>
                        <span style="color: #e74c3c; font-size: 11px; margin-left: auto;">已拒绝</span>
                      </div>
                      <div style="white-space: pre-wrap; word-break: break-all; overflow-wrap: break-word; font-size: 13px; color: #666;">{rr.result || '-'}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style="margin-top: 15px;">
              <a href="/dvm" class="btn">返回市场</a>
            </div>
          </div>

          <aside class="dvm-sidebar">
            <div class="sidebar">
              <div class="sidebar-title">任务信息</div>
              <ul class="sidebar-list" style="font-size: 12px;">
                <li>Kind: {job.kind}</li>
                <li>状态: {job.status}</li>
                <li>创建: {job.createdAt.toLocaleDateString('zh-CN')}</li>
                <li>更新: {job.updatedAt.toLocaleDateString('zh-CN')}</li>
              </ul>
            </div>

            {isOwner && (job.status === 'open' || job.status === 'processing') && (
              <div class="sidebar">
                <div class="sidebar-title">操作</div>
                <div style="padding: 12px 15px;">
                  <form method="POST" action={`/dvm/jobs/${job.id}/cancel`}>
                    <button type="submit" class="btn" style="width: 100%;"
                      onclick="return confirm('确定要取消此任务吗？')">
                      取消任务
                    </button>
                  </form>
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </Layout>
  )
})

// POST /dvm/jobs/:id/cancel — 取消任务（页面表单）
dvm.post('/jobs/:id/cancel', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  if (!user) return c.redirect('/auth/login?tab=agent')

  const jobId = c.req.param('id')
  const job = await db
    .select({ id: dvmJobs.id, userId: dvmJobs.userId, status: dvmJobs.status })
    .from(dvmJobs)
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.userId, user.id)))
    .limit(1)

  if (job.length > 0 && (job[0].status === 'open' || job[0].status === 'processing')) {
    await db
      .update(dvmJobs)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(dvmJobs.id, jobId))
  }

  return c.redirect(`/dvm/jobs/${jobId}`)
})

// POST /dvm/jobs/:id/reject — 拒绝结果，重新开放（页面表单）
dvm.post('/jobs/:id/reject', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  if (!user) return c.redirect('/auth/login?tab=agent')

  const jobId = c.req.param('id')
  const job = await db
    .select({ id: dvmJobs.id, userId: dvmJobs.userId, status: dvmJobs.status, role: dvmJobs.role, requestEventId: dvmJobs.requestEventId })
    .from(dvmJobs)
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.userId, user.id), eq(dvmJobs.role, 'customer')))
    .limit(1)

  if (job.length > 0 && job[0].status === 'result_available') {
    await db.update(dvmJobs)
      .set({
        status: 'open',
        result: null,
        resultEventId: null,
        providerPubkey: null,
        priceMsats: null,
        updatedAt: new Date(),
      })
      .where(eq(dvmJobs.id, jobId))

    // 标记 provider job 为 rejected
    if (job[0].requestEventId) {
      await db.update(dvmJobs)
        .set({ status: 'rejected', updatedAt: new Date() })
        .where(and(
          eq(dvmJobs.requestEventId, job[0].requestEventId),
          eq(dvmJobs.role, 'provider'),
          inArray(dvmJobs.status, ['completed', 'result_available']),
        ))
    }
  }

  return c.redirect(`/dvm/jobs/${jobId}`)
})

export default dvm
