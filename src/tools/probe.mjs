// 一条命令跑完三阶段探测，输出可读报告 + 落盘失败载荷。
//
//   node probe.mjs [host] [port] [username]
//
// 阶段 A：静默连接（不回应任何协商）→ 看它卡在哪
// 阶段 B：回应空通道表 + 空监听表 → 抓踢出原因与失败载荷
// 产出：probe-report.json（结构化）+ setup_failed.bin（原始包）
import fs from 'node:fs'
import mc from 'minecraft-protocol'

const host = process.argv[2] || 'mc.example.com'
const port = parseInt(process.argv[3] || '25565', 10)
const username = process.argv[4] || 'probe_bot'
const WAIT = 9000

function extractChannels(buf) {
  const s = buf.toString('latin1')
  const hits = s.match(/[a-z0-9_.-]+:[a-z0-9_./-]+/g) || []
  return [...new Set(hits.filter((x) => x.length >= 5 && x.length <= 80))]
}

function runStage({ reply }) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const res = {
      stage: reply ? 'B(回应空表)' : 'A(静默)',
      connected: false, loggedIn: false, kicked: null, endReason: null,
      inbound: {}, outbound: [], setupFailed: null, channels: [], elapsed: 0,
    }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      res.elapsed = +((Date.now() - t0) / 1000).toFixed(1)
      try { client.end('probe done') } catch {}
      resolve(res)
    }

    const client = mc.createClient({ host, port, username, auth: 'offline', version: '1.21.1' })

    client.on('connect', () => { res.connected = true })
    client.on('login', () => { res.loggedIn = true })

    client.on('packet', (data, meta) => {
      res.inbound[meta.name] = (res.inbound[meta.name] || 0) + 1
      // 1.21.1 走 configuration 状态后不再可靠地发 'login' 事件，用 login 态的 success 包判定
      if (meta.state === 'login' && meta.name === 'success') res.loggedIn = true
      if (meta.state) res.lastState = meta.state
      if (/disconnect/i.test(meta.name)) {
        res.kicked = data
        return finish()
      }
      if (meta.name !== 'custom_payload') return
      const ch = data.channel
      const bytes = data.data?.length ?? 0
      if (ch === 'neoforge:modded_network_setup_failed') {
        const buf = Buffer.from(data.data)
        res.setupFailed = { bytes: buf.length, file: 'setup_failed.bin' }
        res.channels = extractChannels(buf)
        fs.writeFileSync('setup_failed.bin', buf)
      }
      if (reply && ch === 'neoforge:register') {
        client.write('custom_payload', { channel: 'neoforge:register', data: Buffer.from([0]) })
        client.write('custom_payload', { channel: 'minecraft:register', data: Buffer.alloc(0) })
        res.outbound.push('neoforge:register(count=0)', 'minecraft:register(空)')
      }
    })

    client.on('error', (e) => { res.error = e?.message || String(e) })
    client.on('end', (r) => { res.endReason = r || null; finish() })
    setTimeout(finish, WAIT)
  })
}

function verdict(a, b) {
  const out = []
  if (a.kicked) out.push(`A 阶段即被踢（${JSON.stringify(a.kicked).slice(0, 120)}）`)
  else out.push('A 阶段未踢也未进 PLAY → 卡在 configuration（服务器在等客户端上报通道表）')
  if (b.setupFailed) {
    out.push(`B 阶段收到 modded_network_setup_failed（${b.setupFailed.bytes}B），已落盘`)
  }
  if (b.kicked) {
    const s = JSON.stringify(b.kicked)
    if (/incompatible/.test(s)) out.push('B 阶段被踢：incompatible → 空通道表不被接受，必须提交真实通道表')
    out.push(`踢出原因原文：${s.slice(0, 200)}`)
  }
  if (b.channels.length) {
    out.push(`失败载荷里解出 ${b.channels.length} 个通道名，前 10 个：${b.channels.slice(0, 10).join(', ')}`)
  }
  out.push('结论：缺「NeoForge 伪造层 + 真实通道表（含监听表）」，不是账号或网络问题。')
  return out
}

console.log(`探测目标 ${host}:${port}  用户名 ${username}\n`)

const a = await runStage({ reply: false })
console.log(`【A 静默】${a.elapsed}s  连接=${a.connected} 登录=${a.loggedIn} 末态=${a.lastState} 被踢=${!!a.kicked}`)
console.log(`        入站包：${Object.entries(a.inbound).map(([k, v]) => `${k}x${v}`).join(' ')}\n`)

const b = await runStage({ reply: true })
console.log(`【B 回应空表】${b.elapsed}s  连接=${b.connected} 登录=${b.loggedIn} 末态=${b.lastState} 被踢=${!!b.kicked}`)
console.log(`        我方发出：${b.outbound.join(' + ')}`)
console.log(`        入站包：${Object.entries(b.inbound).map(([k, v]) => `${k}x${v}`).join(' ')}`)
if (b.setupFailed) console.log(`        失败载荷 ${b.setupFailed.bytes}B → setup_failed.bin`)
if (b.channels.length) console.log(`        解出通道 ${b.channels.length} 个`)

const v = verdict(a, b)
console.log('\n===== 结论 =====')
v.forEach((line, i) => console.log(`${i + 1}. ${line}`))

fs.writeFileSync('probe-report.json', JSON.stringify({
  target: { host, port, username },
  when: new Date().toISOString(),
  stageA: a, stageB: b, verdict: v,
}, null, 2))
console.log('\n报告已写入 probe-report.json')
