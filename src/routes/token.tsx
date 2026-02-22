import { Hono } from 'hono'
import { eq, sql, and } from 'drizzle-orm'
import type { AppContext } from '../types'
import { groups, groupMembers, groupTokens, tokenBalances, users, topics, comments, topicLikes } from '../db/schema'
import { Layout } from '../components/Layout'
import { generateId } from '../lib/utils'
import { creditToken, recordTokenTx, getClaimableAmount, getRemainingPool } from '../lib/token'

const token = new Hono<AppContext>()

/** Resolve group ID or actorName to actual group ID */
async function resolveGroupId(db: any, idOrSlug: string): Promise<string | null> {
  const byId = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, idOrSlug)).limit(1)
  if (byId.length > 0) return byId[0].id
  const byActor = await db.select({ id: groups.id }).from(groups).where(eq(groups.actorName, idOrSlug)).limit(1)
  return byActor.length > 0 ? byActor[0].id : null
}

// Helper: get file extension from File
function getExtFromFile(filename: string, mimeType: string): string {
  const match = filename.match(/\.(\w+)$/)
  if (match) {
    const ext = match[1].toLowerCase()
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
      return ext === 'jpg' ? 'jpeg' : ext
    }
  }
  const mimeMap: Record<string, string> = {
    'image/jpeg': 'jpeg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
  }
  return mimeMap[mimeType] || 'png'
}

function getContentType(ext: string): string {
  const types: Record<string, string> = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  }
  return types[ext] || 'image/png'
}

// ─── GET /:id/token — Token Management Page ───

token.get('/:id/token', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const groupIdParam = c.req.param('id')

  if (!user) return c.redirect('/auth/login')

  const groupId = await resolveGroupId(db, groupIdParam)
  if (!groupId) return c.notFound()

  const groupResult = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1)
  if (groupResult.length === 0) return c.notFound()

  const groupData = groupResult[0]
  const groupSlug = groupData.actorName || groupId

  if (groupData.creatorId !== user.id) {
    return c.redirect(`/group/${groupSlug}`)
  }

  // Query token for this group
  const tokenResult = await db.select().from(groupTokens).where(eq(groupTokens.groupId, groupId)).limit(1)
  const tokenData = tokenResult.length > 0 ? tokenResult[0] : null

  const message = c.req.query('msg') || null
  const error = c.req.query('error') || null

  if (!tokenData) {
    // ─── Issue Form (no token yet) ───
    return c.html(
      <Layout user={user} title={`发行 Token - ${groupData.name}`} unreadCount={c.get('unreadNotificationCount')} siteName={c.env.APP_NAME}>
        <div class="new-topic-page">
          <div class="page-header">
            <h1>发行小组 Token</h1>
            <p class="page-subtitle"><a href={`/group/${groupSlug}`}>{groupData.name}</a> / <a href={`/group/${groupSlug}/settings`}>设置</a></p>
          </div>

          {error && <p style="color: #c00; margin-bottom: 1rem;">{error}</p>}

          <div style="background: #fff0f0; border: 1px solid #ffcdd2; border-radius: 6px; padding: 12px 16px; margin-bottom: 20px; font-size: 13px; color: #c00; line-height: 1.6;">
            <strong>请注意：Token 发行后，名称、符号、总量、管理员留存比例均不可修改。</strong><br />
            请仔细确认以下参数后再点击发行。行为奖励等设置发行后仍可调整。
          </div>

          <form action={`/group/${groupId}/token/issue`} method="POST" enctype="multipart/form-data" class="topic-form"
            onsubmit="return confirm('Token 发行后，名称、符号、总量、管理员留存比例将无法修改。\n\n确认发行？')">
            <div class="form-group">
              <label for="name">Token 名称</label>
              <input type="text" id="name" name="name" placeholder="如：光影币" required />
            </div>

            <div class="form-group">
              <label for="symbol">符号 <span style="color: #999; font-weight: normal;">(2-8字符，全站唯一)</span></label>
              <input type="text" id="symbol" name="symbol" placeholder="如：PHOTO" required minlength={2} maxlength={8} style="max-width: 200px;" />
            </div>

            <div class="form-group">
              <label for="iconFile">Token 图标</label>
              <input type="file" id="iconFile" name="iconFile" accept="image/*" />
              <p style="color: #999; font-size: 12px; margin-top: 5px;">支持 JPG/PNG/GIF/WebP</p>
            </div>

            <div class="form-group">
              <label for="iconEmoji">或使用 Emoji <span style="color: #999; font-weight: normal;">(没有上传图片时使用)</span></label>
              <input type="text" id="iconEmoji" name="iconEmoji" placeholder="如：📷" style="max-width: 100px;" />
            </div>

            <div class="form-group">
              <label for="totalSupply">总量 <span style="color: #999; font-weight: normal;">(0=无上限)</span></label>
              <input type="number" id="totalSupply" name="totalSupply" value="0" min="0" style="max-width: 200px;" />
            </div>

            <h3 style="margin-top: 24px; margin-bottom: 12px; padding-top: 16px; border-top: 1px solid #e8e8e8;">分配</h3>

            <div class="form-group">
              <label for="adminAllocationPct">管理员留存 % <span style="color: #999; font-weight: normal;">(0-100)</span></label>
              <input type="number" id="adminAllocationPct" name="adminAllocationPct" value="0" min="0" max="100" style="max-width: 120px;" />
            </div>

            <div class="form-group">
              <label for="airdropPerMember">空投每人（枚） <span style="color: #999; font-weight: normal;">(0=不空投)</span></label>
              <input type="number" id="airdropPerMember" name="airdropPerMember" value="0" min="0" style="max-width: 200px;" />
              <p style="color: #999; font-size: 12px; margin-top: 4px;">发行时给每位现有成员空投的 Token 数量</p>
            </div>

            <h3 style="margin-top: 24px; margin-bottom: 12px; padding-top: 16px; border-top: 1px solid #e8e8e8;">行为奖励</h3>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; max-width: 400px;">
              <div class="form-group">
                <label for="rewardPost">发帖奖励</label>
                <input type="number" id="rewardPost" name="rewardPost" value="0" min="0" />
              </div>
              <div class="form-group">
                <label for="rewardReply">回复奖励</label>
                <input type="number" id="rewardReply" name="rewardReply" value="0" min="0" />
              </div>
              <div class="form-group">
                <label for="rewardLike">点赞奖励</label>
                <input type="number" id="rewardLike" name="rewardLike" value="0" min="0" />
              </div>
              <div class="form-group">
                <label for="rewardLiked">被赞奖励</label>
                <input type="number" id="rewardLiked" name="rewardLiked" value="0" min="0" />
              </div>
            </div>

            <div class="form-group">
              <label for="dailyRewardCap">每日挖矿上限 <span style="color: #999; font-weight: normal;">(0=无限)</span></label>
              <input type="number" id="dailyRewardCap" name="dailyRewardCap" value="0" min="0" style="max-width: 200px;" />
            </div>

            <h3 style="margin-top: 24px; margin-bottom: 12px; padding-top: 16px; border-top: 1px solid #e8e8e8;">高级设置</h3>

            <div class="form-option">
              <label class="checkbox-label">
                <input type="checkbox" name="airdropOnJoin" value="1" />
                新成员入组自动空投
              </label>
              <p style="color: #999; font-size: 12px; margin: 2px 0 0 24px;">勾选后，新用户加入小组时自动获得上面设置的「空投每人」数量的 Token</p>
            </div>

            <div class="form-option">
              <label class="checkbox-label">
                <input type="checkbox" name="airdropWeighted" value="1" />
                空投按历史贡献加权分配
              </label>
              <p style="color: #999; font-size: 12px; margin: 2px 0 0 24px;">勾选后，发行时的初始空投不再均分，而是按成员历史贡献（发帖×3 + 回复×2 + 点赞×1）加权分配，活跃用户获得更多。不勾选则每人相同数量。</p>
            </div>

            <div class="form-group" style="margin-top: 12px;">
              <label for="halvingInterval">减半间隔 <span style="color: #999; font-weight: normal;">(0=不减半，奖励永远不变)</span></label>
              <input type="number" id="halvingInterval" name="halvingInterval" value="0" min="0" style="max-width: 200px;"
                oninput="document.getElementById('halving-detail').style.display=this.value>0?'block':'none'" />
              <p style="color: #999; font-size: 12px; margin-top: 4px;">每释放多少枚 Token 后，行为奖励自动衰减。设为 0 则奖励金额始终不变。</p>
            </div>

            <div id="halving-detail" style="display: none;">
              <div class="form-group">
                <label for="halvingRatio">减半比例 % <span style="color: #999; font-weight: normal;">(默认50)</span></label>
                <input type="number" id="halvingRatio" name="halvingRatio" value="50" min="1" max="99" style="max-width: 120px;" />
                <p style="color: #999; font-size: 12px; margin-top: 4px;">每次触发减半时，奖励变为原来的百分之几。50 = 减一半，75 = 减 25%</p>
              </div>

              <div style="background: #f8f9fa; border-radius: 6px; padding: 12px; margin: 4px 0 16px; font-size: 13px; color: #666; line-height: 1.6;">
                <strong style="color: #333;">示例</strong>：总量 2100 万，发帖奖励 50，减半间隔 500 万，减半比例 50%<br />
                前 500 万枚：发帖 +50<br />
                500 万 ~ 1000 万：发帖 +25（第一次减半）<br />
                1000 万 ~ 1500 万：发帖 +12（第二次减半）<br />
                1500 万 ~ 2000 万：发帖 +6（第三次减半）<br />
                越早参与，获得的奖励越多，类似比特币挖矿机制。
              </div>
            </div>

            <div class="form-group">
              <label for="vestingMonths">管理员锁仓期（月） <span style="color: #999; font-weight: normal;">(0=立即到账)</span></label>
              <input type="number" id="vestingMonths" name="vestingMonths" value="0" min="0" style="max-width: 120px;" />
            </div>

            <div style="background: #f8f9fa; border-radius: 6px; padding: 12px; margin: 4px 0 16px; font-size: 13px; color: #666; line-height: 1.6;">
              <strong style="color: #333;">什么是锁仓？</strong><br />
              上面「管理员留存」的 Token 不会一次性全部到账，而是按月分批释放，管理员需要手动领取。<br /><br />
              <strong style="color: #333;">示例</strong>：总量 100 万，管理员留存 10%（= 10 万），锁仓期 12 个月<br />
              发行时管理员余额为 0，之后每月可领取约 8,333 枚，12 个月后全部领完。<br />
              设为 0 则留存部分发行时立即全部到账。<br /><br />
              <span style="color: #999;">目的：防止管理员一次性拿走所有 Token，让社区更放心。</span>
            </div>

            <div class="form-actions">
              <button type="submit" class="btn btn-primary">发行 Token</button>
              <a href={`/group/${groupSlug}/settings`} class="btn">取消</a>
            </div>
          </form>
        </div>
      </Layout>
    )
  }

  // ─── Dashboard (token exists) ───
  const adminAlloc = Math.floor(tokenData.totalSupply * tokenData.adminAllocationPct / 100)
  const remainingPool = getRemainingPool(tokenData)
  const claimableAmount = getClaimableAmount(tokenData)

  // Count holders
  const holderCountResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(tokenBalances)
    .where(and(eq(tokenBalances.tokenId, tokenData.id), sql`${tokenBalances.balance} > 0`))
  const holderCount = holderCountResult[0]?.count || 0

  return c.html(
    <Layout user={user} title={`${tokenData.symbol} Token - ${groupData.name}`} unreadCount={c.get('unreadNotificationCount')} siteName={c.env.APP_NAME}>
      <div class="new-topic-page">
        <div class="page-header">
          <h1>
            {tokenData.iconUrl && !tokenData.iconUrl.startsWith('http') ? (
              <span style="margin-right: 8px; font-size: 28px;">{tokenData.iconUrl}</span>
            ) : tokenData.iconUrl ? (
              <img src={tokenData.iconUrl} alt="" style="width: 32px; height: 32px; border-radius: 50%; vertical-align: middle; margin-right: 8px;" />
            ) : null}
            {tokenData.symbol}
          </h1>
          <p class="page-subtitle"><a href={`/group/${groupSlug}`}>{groupData.name}</a> / <a href={`/group/${groupSlug}/settings`}>设置</a></p>
        </div>

        {message && <p style="color: #2e7d32; margin-bottom: 1rem;">{message}</p>}
        {error && <p style="color: #c00; margin-bottom: 1rem;">{error}</p>}

        {/* Stats */}
        <div style="background: #f8f9fa; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <h3 style="margin-bottom: 12px;">Token 概览</h3>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px;">
            <div>
              <div style="font-size: 13px; color: #666;">名称</div>
              <div style="font-size: 18px; font-weight: bold;">{tokenData.name}</div>
            </div>
            <div>
              <div style="font-size: 13px; color: #666;">总量</div>
              <div style="font-size: 18px; font-weight: bold;">
                {tokenData.totalSupply === 0 ? '\u221E' : tokenData.totalSupply.toLocaleString()}
              </div>
            </div>
            <div>
              <div style="font-size: 13px; color: #666;">已释放（含空投）</div>
              <div style="font-size: 18px; font-weight: bold;">{tokenData.minedTotal.toLocaleString()}</div>
            </div>
            <div>
              <div style="font-size: 13px; color: #666;">矿池剩余</div>
              <div style="font-size: 18px; font-weight: bold;">
                {remainingPool === Infinity ? '\u221E' : remainingPool.toLocaleString()}
              </div>
            </div>
            <div>
              <div style="font-size: 13px; color: #666;">管理员额度</div>
              <div style="font-size: 18px; font-weight: bold;">{adminAlloc.toLocaleString()}</div>
            </div>
            <div>
              <div style="font-size: 13px; color: #666;">已领取</div>
              <div style="font-size: 18px; font-weight: bold;">{tokenData.adminVestedTotal.toLocaleString()}</div>
            </div>
            <div>
              <div style="font-size: 13px; color: #666;">持有人</div>
              <div style="font-size: 18px; font-weight: bold;">{holderCount}</div>
            </div>
          </div>
        </div>

        {/* Claim Vesting */}
        {tokenData.vestingMonths > 0 && tokenData.adminAllocationPct > 0 && (
          <div style="background: #fff3cd; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
            <h3 style="margin-bottom: 8px;">锁仓释放</h3>
            <p style="margin-bottom: 8px; font-size: 14px; color: #666;">
              锁仓期: {tokenData.vestingMonths} 个月 | 可领取: {claimableAmount.toLocaleString()} {tokenData.symbol}
            </p>
            {claimableAmount > 0 ? (
              <form action={`/group/${groupId}/token/claim`} method="POST" style="display: inline;">
                <button type="submit" class="btn btn-primary">领取 {claimableAmount.toLocaleString()} {tokenData.symbol}</button>
              </form>
            ) : (
              <span style="color: #999; font-size: 13px;">暂无可领取额度</span>
            )}
          </div>
        )}

        {/* Reward Settings Form */}
        <div style="margin-bottom: 24px; padding-top: 16px; border-top: 1px solid #e8e8e8;">
          <h3 style="margin-bottom: 12px;">奖励设置</h3>
          <form action={`/group/${groupId}/token/update`} method="POST" class="topic-form">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; max-width: 400px;">
              <div class="form-group">
                <label for="rewardPost">发帖奖励</label>
                <input type="number" id="rewardPost" name="rewardPost" value={String(tokenData.rewardPost)} min="0" />
              </div>
              <div class="form-group">
                <label for="rewardReply">回复奖励</label>
                <input type="number" id="rewardReply" name="rewardReply" value={String(tokenData.rewardReply)} min="0" />
              </div>
              <div class="form-group">
                <label for="rewardLike">点赞奖励</label>
                <input type="number" id="rewardLike" name="rewardLike" value={String(tokenData.rewardLike)} min="0" />
              </div>
              <div class="form-group">
                <label for="rewardLiked">被赞奖励</label>
                <input type="number" id="rewardLiked" name="rewardLiked" value={String(tokenData.rewardLiked)} min="0" />
              </div>
            </div>

            <div class="form-group">
              <label for="dailyRewardCap">每日挖矿上限 <span style="color: #999; font-weight: normal;">(0=无限)</span></label>
              <input type="number" id="dailyRewardCap" name="dailyRewardCap" value={String(tokenData.dailyRewardCap)} min="0" style="max-width: 200px;" />
            </div>

            <div class="form-option">
              <label class="checkbox-label">
                <input type="checkbox" name="airdropOnJoin" value="1" checked={tokenData.airdropOnJoin === 1} />
                新成员入组自动空投
              </label>
            </div>

            <div class="form-group" style="margin-top: 12px;">
              <label for="halvingInterval">减半间隔 <span style="color: #999; font-weight: normal;">(0=不减半)</span></label>
              <input type="number" id="halvingInterval" name="halvingInterval" value={String(tokenData.halvingInterval)} min="0" style="max-width: 200px;" />
            </div>

            <div class="form-group">
              <label for="halvingRatio">减半比例 % <span style="color: #999; font-weight: normal;">(默认50)</span></label>
              <input type="number" id="halvingRatio" name="halvingRatio" value={String(tokenData.halvingRatio)} min="1" max="99" style="max-width: 120px;" />
            </div>

            <div class="form-actions">
              <button type="submit" class="btn btn-primary">保存设置</button>
            </div>
          </form>
        </div>

        {/* Manual Distribution */}
        <div style="margin-bottom: 24px; padding-top: 16px; border-top: 1px solid #e8e8e8;">
          <h3 style="margin-bottom: 12px;">手动分发 Token</h3>
          <form action={`/group/${groupId}/token/distribute`} method="POST" class="topic-form">
            <div class="form-group">
              <label for="toUsername">用户名</label>
              <input type="text" id="toUsername" name="toUsername" placeholder="输入用户名" required style="max-width: 300px;" />
            </div>
            <div class="form-group">
              <label for="amount">数量 ({tokenData.symbol})</label>
              <input type="number" id="amount" name="amount" min="1" required style="max-width: 200px;" />
            </div>
            <div class="form-group">
              <label for="memo">备注 <span style="color: #999; font-weight: normal;">(可选)</span></label>
              <input type="text" id="memo" name="memo" placeholder="分发原因" style="max-width: 400px;" />
            </div>
            <div class="form-actions">
              <button type="submit" class="btn btn-primary">分发</button>
            </div>
          </form>
        </div>
      </div>
    </Layout>
  )
})

// ─── POST /:id/token/issue — Issue Token ───

token.post('/:id/token/issue', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const groupId = c.req.param('id')

  if (!user) return c.redirect('/auth/login')

  const groupResult = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1)
  if (groupResult.length === 0) return c.notFound()
  const groupData = groupResult[0]
  const groupSlug = groupData.actorName || groupId

  if (groupData.creatorId !== user.id) return c.redirect(`/group/${groupSlug}`)

  // Check if token already exists
  const existing = await db.select({ id: groupTokens.id }).from(groupTokens).where(eq(groupTokens.groupId, groupId)).limit(1)
  if (existing.length > 0) return c.redirect(`/group/${groupSlug}/token?error=Token+already+exists`)

  const body = await c.req.parseBody()
  const name = (body.name as string)?.trim()
  const symbol = (body.symbol as string)?.trim().toUpperCase()
  const totalSupply = parseInt(body.totalSupply as string) || 0
  const adminAllocationPct = Math.min(100, Math.max(0, parseInt(body.adminAllocationPct as string) || 0))
  const airdropPerMember = parseInt(body.airdropPerMember as string) || 0
  const rewardPost = parseInt(body.rewardPost as string) || 0
  const rewardReply = parseInt(body.rewardReply as string) || 0
  const rewardLike = parseInt(body.rewardLike as string) || 0
  const rewardLiked = parseInt(body.rewardLiked as string) || 0
  const dailyRewardCap = parseInt(body.dailyRewardCap as string) || 0
  const airdropOnJoin = body.airdropOnJoin === '1' ? 1 : 0
  const airdropWeighted = body.airdropWeighted === '1' ? 1 : 0
  const halvingInterval = parseInt(body.halvingInterval as string) || 0
  const halvingRatio = Math.min(99, Math.max(1, parseInt(body.halvingRatio as string) || 50))
  const vestingMonths = parseInt(body.vestingMonths as string) || 0
  const iconFile = body.iconFile as File | undefined
  const iconEmoji = (body.iconEmoji as string)?.trim()

  if (!name || !symbol) {
    return c.redirect(`/group/${groupSlug}/token?error=${encodeURIComponent('请填写名称和符号')}`)
  }

  if (symbol.length < 2 || symbol.length > 8) {
    return c.redirect(`/group/${groupSlug}/token?error=${encodeURIComponent('符号需要 2-8 个字符')}`)
  }

  const tokenId = generateId()
  let iconUrl: string = ''

  // Handle icon upload
  if (iconFile && iconFile.size > 0 && c.env.R2) {
    try {
      const buffer = await iconFile.arrayBuffer()
      const ext = getExtFromFile(iconFile.name, iconFile.type)
      const contentType = getContentType(ext)
      const key = `tokens/${tokenId}.${ext}`
      await c.env.R2.put(key, buffer, { httpMetadata: { contentType } })
      const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
      iconUrl = `${baseUrl}/r2/${key}`
    } catch (error) {
      console.error('Failed to upload token icon:', error)
    }
  }

  // Fallback to emoji or default
  if (!iconUrl) {
    iconUrl = iconEmoji || '\u{1F4B0}'
  }

  // Determine vesting start
  const vestingStartAt = vestingMonths > 0 ? Math.floor(Date.now() / 1000) : null

  // Insert token
  await db.insert(groupTokens).values({
    id: tokenId,
    groupId,
    name,
    symbol,
    iconUrl,
    totalSupply,
    minedTotal: 0,
    adminAllocationPct,
    airdropPerMember,
    rewardPost,
    rewardReply,
    rewardLike,
    rewardLiked,
    dailyRewardCap,
    airdropOnJoin,
    airdropWeighted,
    halvingInterval,
    halvingRatio,
    vestingMonths,
    vestingStartAt,
    adminVestedTotal: 0,
    createdAt: new Date(),
  })

  // ─── Admin allocation (immediate if no vesting) ───
  const adminAlloc = Math.floor(totalSupply * adminAllocationPct / 100)
  if (vestingMonths === 0 && adminAlloc > 0) {
    await creditToken(db, user.id, tokenId, 'local', adminAlloc)
    await recordTokenTx(db, {
      tokenId,
      tokenType: 'local',
      toUserId: user.id,
      amount: adminAlloc,
      type: 'admin_mint',
      refId: groupId,
      refType: 'group',
      memo: '管理员初始分配',
    })
  }

  // ─── Airdrop to existing members ───
  const members = await db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId))

  if (members.length > 0 && airdropPerMember > 0) {
    let airdropTotal = 0

    if (airdropWeighted) {
      // Weighted airdrop by contribution
      const memberScores: { userId: string; score: number }[] = []
      let totalScore = 0

      for (const member of members) {
        // Count posts
        const postCount = await db
          .select({ count: sql<number>`count(*)` })
          .from(topics)
          .where(and(eq(topics.groupId, groupId), eq(topics.userId, member.userId)))
        const posts = postCount[0]?.count || 0

        // Count replies (comments on topics in this group)
        const replyCount = await db
          .select({ count: sql<number>`count(*)` })
          .from(comments)
          .where(and(
            eq(comments.userId, member.userId),
            sql`${comments.topicId} IN (SELECT id FROM topic WHERE group_id = ${groupId})`
          ))
        const replies = replyCount[0]?.count || 0

        // Count likes given in this group
        const likeCount = await db
          .select({ count: sql<number>`count(*)` })
          .from(topicLikes)
          .where(and(
            eq(topicLikes.userId, member.userId),
            sql`${topicLikes.topicId} IN (SELECT id FROM topic WHERE group_id = ${groupId})`
          ))
        const likes = likeCount[0]?.count || 0

        const score = posts * 3 + replies * 2 + likes * 1
        memberScores.push({ userId: member.userId, score })
        totalScore += score
      }

      if (totalScore === 0) {
        // Fall back to equal split
        const perPerson = airdropPerMember
        for (const member of members) {
          await creditToken(db, member.userId, tokenId, 'local', perPerson)
          await recordTokenTx(db, {
            tokenId,
            tokenType: 'local',
            toUserId: member.userId,
            amount: perPerson,
            type: 'airdrop',
            refId: groupId,
            refType: 'group_issue',
            memo: '初始空投（均分）',
          })
          airdropTotal += perPerson
        }
      } else {
        // Weighted distribution: total pool = airdropPerMember * member count
        const totalPool = airdropPerMember * members.length
        for (const ms of memberScores) {
          const amount = Math.floor(totalPool * ms.score / totalScore)
          if (amount > 0) {
            await creditToken(db, ms.userId, tokenId, 'local', amount)
            await recordTokenTx(db, {
              tokenId,
              tokenType: 'local',
              toUserId: ms.userId,
              amount,
              type: 'airdrop',
              refId: groupId,
              refType: 'group_issue',
              memo: '初始空投（加权）',
            })
            airdropTotal += amount
          }
        }
      }
    } else {
      // Equal airdrop
      const perPerson = airdropPerMember
      for (const member of members) {
        await creditToken(db, member.userId, tokenId, 'local', perPerson)
        await recordTokenTx(db, {
          tokenId,
          tokenType: 'local',
          toUserId: member.userId,
          amount: perPerson,
          type: 'airdrop',
          refId: groupId,
          refType: 'group_issue',
          memo: '初始空投',
        })
        airdropTotal += perPerson
      }
    }

    // Update minedTotal
    if (airdropTotal > 0) {
      await db.run(
        sql`UPDATE group_token SET mined_total = mined_total + ${airdropTotal} WHERE id = ${tokenId}`
      )
    }
  }

  return c.redirect(`/group/${groupSlug}/token?msg=${encodeURIComponent('Token 发行成功！')}`)
})

// ─── POST /:id/token/update — Update Reward Rules ───

token.post('/:id/token/update', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const groupId = c.req.param('id')

  if (!user) return c.redirect('/auth/login')

  const groupResult = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1)
  if (groupResult.length === 0) return c.notFound()
  const groupData = groupResult[0]
  const groupSlug = groupData.actorName || groupId

  if (groupData.creatorId !== user.id) return c.redirect(`/group/${groupSlug}`)

  const tokenResult = await db.select().from(groupTokens).where(eq(groupTokens.groupId, groupId)).limit(1)
  if (tokenResult.length === 0) return c.redirect(`/group/${groupSlug}/token`)

  const body = await c.req.parseBody()
  const rewardPost = parseInt(body.rewardPost as string) || 0
  const rewardReply = parseInt(body.rewardReply as string) || 0
  const rewardLike = parseInt(body.rewardLike as string) || 0
  const rewardLiked = parseInt(body.rewardLiked as string) || 0
  const dailyRewardCap = parseInt(body.dailyRewardCap as string) || 0
  const airdropOnJoin = body.airdropOnJoin === '1' ? 1 : 0
  const halvingInterval = parseInt(body.halvingInterval as string) || 0
  const halvingRatio = Math.min(99, Math.max(1, parseInt(body.halvingRatio as string) || 50))

  await db.update(groupTokens).set({
    rewardPost,
    rewardReply,
    rewardLike,
    rewardLiked,
    dailyRewardCap,
    airdropOnJoin,
    halvingInterval,
    halvingRatio,
  }).where(eq(groupTokens.id, tokenResult[0].id))

  return c.redirect(`/group/${groupSlug}/token?msg=${encodeURIComponent('设置已保存')}`)
})

// ─── POST /:id/token/distribute — Manual Distribution ───

token.post('/:id/token/distribute', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const groupId = c.req.param('id')

  if (!user) return c.redirect('/auth/login')

  const groupResult = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1)
  if (groupResult.length === 0) return c.notFound()
  const groupData = groupResult[0]
  const groupSlug = groupData.actorName || groupId

  if (groupData.creatorId !== user.id) return c.redirect(`/group/${groupSlug}`)

  const tokenResult = await db.select().from(groupTokens).where(eq(groupTokens.groupId, groupId)).limit(1)
  if (tokenResult.length === 0) return c.redirect(`/group/${groupSlug}/token`)
  const tokenData = tokenResult[0]

  const body = await c.req.parseBody()
  const toUsername = (body.toUsername as string)?.trim()
  const amount = parseInt(body.amount as string) || 0
  const memo = (body.memo as string)?.trim() || null

  if (!toUsername || amount <= 0) {
    return c.redirect(`/group/${groupSlug}/token?error=${encodeURIComponent('请填写用户名和数量')}`)
  }

  // Lookup recipient
  const recipientResult = await db.select().from(users).where(eq(users.username, toUsername)).limit(1)
  if (recipientResult.length === 0) {
    return c.redirect(`/group/${groupSlug}/token?error=${encodeURIComponent('用户不存在: ' + toUsername)}`)
  }
  const recipient = recipientResult[0]

  // Check remaining pool
  const remaining = getRemainingPool(tokenData)
  if (remaining < amount) {
    return c.redirect(`/group/${groupSlug}/token?error=${encodeURIComponent('矿池余量不足，剩余: ' + (remaining === Infinity ? '无限' : remaining))}`)
  }

  // Credit tokens
  await creditToken(db, recipient.id, tokenData.id, 'local', amount)
  await recordTokenTx(db, {
    tokenId: tokenData.id,
    tokenType: 'local',
    fromUserId: null,
    toUserId: recipient.id,
    amount,
    type: 'admin_distribute',
    refId: groupId,
    refType: 'group',
    memo,
  })

  // Update minedTotal via CAS
  await db.run(
    sql`UPDATE group_token SET mined_total = mined_total + ${amount}
        WHERE id = ${tokenData.id}
        AND (total_supply = 0
             OR mined_total + ${amount} <= total_supply - CAST(total_supply * admin_allocation_pct / 100 AS INTEGER))`
  )

  return c.redirect(`/group/${groupSlug}/token?msg=${encodeURIComponent(`已分发 ${amount} ${tokenData.symbol} 给 ${toUsername}`)}`)
})

// ─── POST /:id/token/claim — Claim Vesting Release ───

token.post('/:id/token/claim', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const groupId = c.req.param('id')

  if (!user) return c.redirect('/auth/login')

  const groupResult = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1)
  if (groupResult.length === 0) return c.notFound()
  const groupData = groupResult[0]
  const groupSlug = groupData.actorName || groupId

  if (groupData.creatorId !== user.id) return c.redirect(`/group/${groupSlug}`)

  const tokenResult = await db.select().from(groupTokens).where(eq(groupTokens.groupId, groupId)).limit(1)
  if (tokenResult.length === 0) return c.redirect(`/group/${groupSlug}/token`)
  const tokenData = tokenResult[0]

  const claimable = getClaimableAmount(tokenData)
  if (claimable <= 0) {
    return c.redirect(`/group/${groupSlug}/token?error=${encodeURIComponent('暂无可领取额度')}`)
  }

  // Credit tokens to admin
  await creditToken(db, user.id, tokenData.id, 'local', claimable)
  await recordTokenTx(db, {
    tokenId: tokenData.id,
    tokenType: 'local',
    toUserId: user.id,
    amount: claimable,
    type: 'admin_vest_claim',
    refId: groupId,
    refType: 'group',
    memo: '锁仓释放领取',
  })

  // Update adminVestedTotal
  await db.run(
    sql`UPDATE group_token SET admin_vested_total = admin_vested_total + ${claimable} WHERE id = ${tokenData.id}`
  )

  return c.redirect(`/group/${groupSlug}/token?msg=${encodeURIComponent(`已领取 ${claimable} ${tokenData.symbol}`)}`)
})

export default token
