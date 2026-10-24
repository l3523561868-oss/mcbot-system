// 探针：用最朴素的离线连接试探服务器到底卡在哪一步。
// 不装伪造层、不带任何 mod 通道声明 —— 目的就是看它怎么被踢、踢在哪一层。
//
// 用法： node probe_connect.mjs [host] [port] [username]
import mc from 'minecraft-protocol'

const host = process.argv[2] || 'mc.example.com'
const port = parseInt(process.argv[3] || '25565', 10)
const username = process.argv[4] || 'probe_bot'

const t0 = Date.now()
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`
const seen = new Map()      // 包名 -> 次数
let kicked = null

const client = mc.createClient({
  host,
  port,
  username,
  auth: 'offline',
  version: '1.21.1',
})

client.on('connect', () => console.log(`${ts()} [connect] TCP 已建立`))
client.on('login', () => console.log(`${ts()} [login] 已发登录包（离线模式）`))

client.on('packet', (data, meta) => {
  seen.set(meta.name, (seen.get(meta.name) || 0) + 1)
  // 自定义通道 / 协商相关，一律打出来 —— 这就是缺口所在
  if (/custom|register|neoforge|known|config|disconnect/i.test(meta.name)) {
    const brief = JSON.stringify(data).slice(0, 260)
    console.log(`${ts()} [pkt:${meta.state}] ${meta.name} -> ${brief}`)
  }
  if (/disconnect/i.test(meta.name)) {
    kicked = data
    console.log(`${ts()} ★★★ 被踢：${JSON.stringify(data)}`)
  }
})

client.on('error', (e) => console.log(`${ts()} [error] ${e?.message || e}`))
client.on('end', (reason) => console.log(`${ts()} [end] ${reason || '(无原因)'}`))

setTimeout(() => {
  console.log(`\n===== 汇总 =====`)
  console.log('包统计：')
  for (const [k, v] of [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${k} x${v}`)
  }
  console.log(kicked ? `踢出原因：${JSON.stringify(kicked)}` : '未被踢（可能仍在 configuration 阶段）')
  process.exit(0)
}, 20000)
