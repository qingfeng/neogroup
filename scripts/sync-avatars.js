#!/usr/bin/env node

/**
 * 同步用户头像到 R2
 *
 * 使用方法：
 * node scripts/sync-avatars.js
 *
 * 需要先登录 wrangler：npx wrangler login
 */

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')

const R2_BUCKET = 'neogroup-assets'
const SITE_URL = 'https://neogrp.club'

// 执行 wrangler d1 命令
function d1Execute(sql) {
  const result = execSync(
    `npx wrangler d1 execute neogroup --remote --json --command="${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
  )
  const parsed = JSON.parse(result)
  return parsed[0]?.results || []
}

// 下载文件
function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http

    const request = protocol.get(url, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NeoGroup/1.0)'
      }
    }, (response) => {
      // 处理重定向
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(response.headers.location).then(resolve).catch(reject)
        return
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`))
        return
      }

      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve(Buffer.concat(chunks)))
      response.on('error', reject)
    })

    request.on('error', reject)
    request.on('timeout', () => {
      request.destroy()
      reject(new Error('Timeout'))
    })
  })
}

// 上传到 R2
function r2Put(key, buffer, contentType) {
  const tmpFile = `/tmp/r2-upload-${Date.now()}`
  fs.writeFileSync(tmpFile, buffer)

  try {
    execSync(
      `npx wrangler r2 object put "${R2_BUCKET}/${key}" --file="${tmpFile}" --content-type="${contentType}"`,
      { encoding: 'utf-8', stdio: 'pipe' }
    )
    return true
  } catch (e) {
    console.error(`  上传失败: ${e.message}`)
    return false
  } finally {
    fs.unlinkSync(tmpFile)
  }
}

// 获取文件扩展名
function getExtension(url, contentType) {
  // 从 URL 获取
  const urlMatch = url.match(/\.(\w+)(\?|$)/)
  if (urlMatch) {
    const ext = urlMatch[1].toLowerCase()
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) {
      return ext === 'jpg' ? 'jpeg' : ext
    }
  }

  // 默认 png
  return 'png'
}

// 获取 Content-Type
function getContentType(ext) {
  const types = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml'
  }
  return types[ext] || 'image/png'
}

async function main() {
  console.log('获取用户列表...')

  const users = d1Execute('SELECT id, username, avatar_url FROM user WHERE avatar_url IS NOT NULL')
  console.log(`共 ${users.length} 个用户有头像\n`)

  let success = 0
  let skipped = 0
  let failed = 0

  for (const user of users) {
    const { id, username, avatar_url } = user

    // 跳过已经是 R2 URL 的
    if (avatar_url.includes('/r2/') || avatar_url.includes(SITE_URL)) {
      console.log(`[跳过] ${username}: 已是本站 URL`)
      skipped++
      continue
    }

    // 跳过默认头像
    if (avatar_url.includes('default-avatar')) {
      console.log(`[跳过] ${username}: 默认头像`)
      skipped++
      continue
    }

    console.log(`[下载] ${username}: ${avatar_url}`)

    try {
      const buffer = await downloadFile(avatar_url)
      const ext = getExtension(avatar_url)
      const contentType = getContentType(ext)
      const key = `avatars/${id}.${ext}`

      console.log(`  大小: ${(buffer.length / 1024).toFixed(1)} KB`)

      if (r2Put(key, buffer, contentType)) {
        const newUrl = `${SITE_URL}/r2/${key}`

        // 更新数据库
        d1Execute(`UPDATE user SET avatar_url = '${newUrl}' WHERE id = '${id}'`)
        console.log(`  ✓ 已更新: ${newUrl}`)
        success++
      } else {
        failed++
      }
    } catch (e) {
      console.log(`  ✗ 失败: ${e.message}`)
      failed++
    }

    // 避免请求过快
    await new Promise(r => setTimeout(r, 500))
  }

  console.log(`\n完成！成功: ${success}, 跳过: ${skipped}, 失败: ${failed}`)
}

main().catch(console.error)
